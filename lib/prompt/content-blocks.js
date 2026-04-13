const { log } = require('../logger');

/**
 * Build OpenAI Chat Completions content blocks for a deliberation turn.
 * Path C shapes per forge/PATH_C_LOCKED.md: no cache_control, no type "document".
 */
function createContentBlockBuilder({ db, filesServiceClient, config }) {
  const getSessionFiles = db.prepare(`
    SELECT file_id, file_sha256, file_name, file_tokens, file_mime
    FROM session_files
    WHERE session_id = ?
    ORDER BY attached_at ASC
  `);

  async function buildContentBlocks(session, opts = {}) {
    const attached = getSessionFiles.all(session.id);
    if (attached.length === 0) {
      return [{ type: 'text', text: session.problem }];
    }

    const budget = config.fileTokenBudget || 150_000;

    // Pack smallest-first to fit as many files inline as possible
    const sortedSmallestFirst = [...attached].sort((a, b) => a.file_tokens - b.file_tokens);
    const inlined = [];
    const ragRouted = [];
    let runningTotal = 0;
    for (const f of sortedSmallestFirst) {
      if (runningTotal + f.file_tokens <= budget) {
        inlined.push(f);
        runningTotal += f.file_tokens;
      } else {
        ragRouted.push(f);
      }
    }

    const blocks = [];

    // 1. Inlined file blocks (ordered by attached_at via original query)
    const inlinedIds = new Set(inlined.map(f => f.file_id));
    const inlinedOrdered = attached.filter(f => inlinedIds.has(f.file_id));

    for (const f of inlinedOrdered) {
      try {
        const meta = await filesServiceClient.getFile(f.file_id, { includeText: true });
        if (meta.sha256 !== f.file_sha256) {
          blocks.push({
            type: 'text',
            text: `[File "${f.file_name}" integrity check failed (sha256 mismatch). Content unavailable.]`,
          });
          continue;
        }
        if (meta.extraction_status === 'failed') {
          blocks.push({
            type: 'text',
            text: `[File "${f.file_name}" could not be extracted: ${meta.extraction_error || 'unknown error'}. The file is attached but its content is unavailable.]`,
          });
          continue;
        }
        if (meta.extraction_status === 'image') {
          try {
            const { buffer, mime } = await filesServiceClient.getFileBlob(f.file_id);
            if (!buffer || buffer.length === 0) {
              log.warn({ file_id: f.file_id, file_name: f.file_name }, 'image blob empty, skipping');
              blocks.push({
                type: 'text',
                text: `[File "${f.file_name}" image is empty (0 bytes). The file was attached but contains no data.]`,
              });
            } else {
              blocks.push({
                type: 'image_url',
                image_url: { url: `data:${mime || f.file_mime};base64,${buffer.toString('base64')}` },
              });
            }
          } catch (imgErr) {
            blocks.push({
              type: 'text',
              text: `[File "${f.file_name}" image fetch failed: ${imgErr.message}]`,
            });
          }
          continue;
        }
        // Text-bearing file
        blocks.push({
          type: 'text',
          text: `===== ATTACHED FILE: ${f.file_name} (${f.file_mime}, ${f.file_tokens} tokens) =====\n\n${meta.extracted_text || ''}\n\n===== END FILE: ${f.file_name} =====`,
        });
      } catch (err) {
        blocks.push({
          type: 'text',
          text: `[File "${f.file_name}" could not be fetched from files-service: ${err.message}]`,
        });
      }
    }

    // 2. RAG-routed files
    if (ragRouted.length && opts.query) {
      for (const f of ragRouted) {
        try {
          const status = await filesServiceClient.getRagStatus(f.file_id);
          if (status.rag_status === 'none' || status.rag_status === 'pending') {
            await filesServiceClient.triggerChunking(f.file_id);
            blocks.push({
              type: 'text',
              text: `[File "${f.file_name}" is still being indexed for retrieval. It will be available next turn.]`,
            });
            continue;
          }
          if (status.rag_status !== 'ready') {
            blocks.push({
              type: 'text',
              text: `[File "${f.file_name}" retrieval unavailable: rag_status=${status.rag_status}.]`,
            });
            continue;
          }
          const retrieved = await filesServiceClient.retrieve(f.file_id, opts.query, 5);
          const excerpts = retrieved.results.map(r =>
            `[chunk ${r.chunk_index}, similarity ${r.similarity.toFixed(2)}]\n${r.text}`
          ).join('\n\n---\n\n');
          blocks.push({
            type: 'text',
            text: `===== RAG RETRIEVAL: ${f.file_name} =====\n${excerpts}\n===== END RAG =====`,
          });
        } catch (err) {
          blocks.push({
            type: 'text',
            text: `[File "${f.file_name}" RAG retrieval failed: ${err.message}]`,
          });
        }
      }
    } else if (ragRouted.length) {
      for (const f of ragRouted) {
        blocks.push({
          type: 'text',
          text: `[File "${f.file_name}" exceeds inline budget (${f.file_tokens} tokens). RAG retrieval available when query is provided.]`,
        });
      }
    }

    // 3. Context text is ALWAYS the last block. When contextText is provided
    //    (the full user-content string from buildContext), use that so prior
    //    deliberation, memory, escalations, and role instructions are preserved.
    //    Falls back to session.problem for standalone use.
    blocks.push({ type: 'text', text: opts.contextText || session.problem });

    return blocks;
  }

  return { buildContentBlocks };
}

module.exports = { createContentBlockBuilder };
