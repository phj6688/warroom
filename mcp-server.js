const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const crypto = require('crypto');

/**
 * War Room MCP Server
 * Exposes War Room multi-agent research operations as MCP tools
 * Transport: Streamable HTTP (mounted at /mcp on Express app)
 */

// Generate default API key if not set
const DEFAULT_API_KEY = process.env.MCP_API_KEY || crypto.randomUUID();
process.env.MCP_API_KEY = DEFAULT_API_KEY;

console.log(`🔐 MCP API Key: ${DEFAULT_API_KEY}`);

// Tool schemas
const schemas = {
  listSessions: z.object({}),
  
  getSession: z.object({
    sessionId: z.string().describe('Session ID'),
  }),
  
  createSession: z.object({
    problem: z.string().describe('Problem statement or research question'),
    files: z.array(z.object({
      name: z.string(),
      content: z.string().optional(),
      type: z.string().optional(),
      size: z.number().optional(),
    })).optional().describe('Optional attached files'),
  }),
  
  deleteSession: z.object({
    sessionId: z.string().describe('Session ID to delete'),
  }),
  
  askQuestion: z.object({
    sessionId: z.string().describe('Session ID'),
    question: z.string().describe('Follow-up question for the agents'),
  }),
  
  answerEscalation: z.object({
    escalationId: z.string().describe('Escalation ID'),
    answer: z.string().describe('Your answer to the agent\'s question'),
  }),
  
  getEscalations: z.object({
    sessionId: z.string().optional().describe('Filter by session ID (optional)'),
    onlyPending: z.boolean().optional().default(true).describe('Show only pending escalations'),
  }),
  
  getMessages: z.object({
    sessionId: z.string().describe('Session ID'),
    agentId: z.string().optional().describe('Filter by agent ID'),
    phase: z.string().optional().describe('Filter by phase name'),
    pinnedOnly: z.boolean().optional().default(false).describe('Show only pinned messages'),
  }),
  
  exportSession: z.object({
    sessionId: z.string().describe('Session ID to export'),
  }),
  
  searchSessions: z.object({
    query: z.string().describe('Search keyword'),
  }),
};

/**
 * Initialize MCP server and mount on Express app
 * @param {Express} app - Express app instance
 * @param {Object} deps - Dependencies: { db, callLLM, createSession, activeSessions, AGENTS, PHASES }
 */
function setupMCPServer(app, deps) {
  const { db, callLLM, createSession, activeSessions, AGENTS, PHASES } = deps;
  
  // Create a function that returns a new configured server instance
  const createServerInstance = () => {
    const server = new Server(
      {
        name: 'war-room',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // ─── Tool Handlers ─────────────────────────────────────────
  
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'warroom_list_sessions',
          description: 'List all research sessions with summary info',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'warroom_get_session',
          description: 'Get full details of a specific session',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'warroom_create_session',
          description: 'Start a new multi-agent research session',
          inputSchema: {
            type: 'object',
            properties: {
              problem: { type: 'string', description: 'Problem statement or research question' },
              files: {
                type: 'array',
                description: 'Optional attached files',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    content: { type: 'string' },
                    type: { type: 'string' },
                    size: { type: 'number' },
                  },
                  required: ['name'],
                },
              },
            },
            required: ['problem'],
          },
        },
        {
          name: 'warroom_delete_session',
          description: 'Delete a session by ID',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID to delete' },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'warroom_ask_question',
          description: 'Ask a follow-up question to an active/completed session',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              question: { type: 'string', description: 'Follow-up question for the agents' },
            },
            required: ['sessionId', 'question'],
          },
        },
        {
          name: 'warroom_answer_escalation',
          description: 'Answer a pending human escalation',
          inputSchema: {
            type: 'object',
            properties: {
              escalationId: { type: 'string', description: 'Escalation ID' },
              answer: { type: 'string', description: 'Your answer to the agent\'s question' },
            },
            required: ['escalationId', 'answer'],
          },
        },
        {
          name: 'warroom_get_escalations',
          description: 'List escalations (optionally filtered by session)',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Filter by session ID (optional)' },
              onlyPending: { type: 'boolean', description: 'Show only pending escalations', default: true },
            },
            required: [],
          },
        },
        {
          name: 'warroom_get_messages',
          description: 'Get messages from a session with optional filters',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID' },
              agentId: { type: 'string', description: 'Filter by agent ID' },
              phase: { type: 'string', description: 'Filter by phase name' },
              pinnedOnly: { type: 'boolean', description: 'Show only pinned messages', default: false },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'warroom_export_session',
          description: 'Export session as formatted Markdown',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session ID to export' },
            },
            required: ['sessionId'],
          },
        },
        {
          name: 'warroom_search_sessions',
          description: 'Search sessions by keyword in problem or messages',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search keyword' },
            },
            required: ['query'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'warroom_list_sessions': {
          const sessions = db.prepare(`
            SELECT 
              id, problem, phase, active, created_at, updated_at,
              (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id) as message_count,
              (SELECT COUNT(*) FROM escalations WHERE session_id = sessions.id AND status = 'pending') as pending_escalations
            FROM sessions
            ORDER BY created_at DESC
          `).all();

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                sessions: sessions.map(s => ({
                  id: s.id,
                  problem: s.problem.slice(0, 100) + (s.problem.length > 100 ? '...' : ''),
                  phase: PHASES[s.phase]?.name || 'Unknown',
                  status: s.active ? 'active' : 'completed',
                  messageCount: s.message_count,
                  pendingEscalations: s.pending_escalations,
                  createdAt: new Date(s.created_at).toISOString(),
                })),
              }, null, 2),
            }],
          };
        }

        case 'warroom_get_session': {
          const { sessionId } = schemas.getSession.parse(args);
          
          const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
          if (!session) {
            throw new Error(`Session ${sessionId} not found`);
          }

          const messages = db.prepare(`
            SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC
          `).all(sessionId);

          const escalations = db.prepare(`
            SELECT * FROM escalations WHERE session_id = ? ORDER BY created_at ASC
          `).all(sessionId);

          // Check if session_files table exists (might not in older schemas)
          let files = [];
          try {
            files = db.prepare(`
              SELECT * FROM session_files WHERE session_id = ? ORDER BY created_at ASC
            `).all(sessionId);
          } catch (e) {
            // Table doesn't exist, skip files
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: session.id,
                problem: session.problem,
                phase: PHASES[session.phase]?.name || 'Unknown',
                status: session.active ? 'active' : 'completed',
                messages: messages.map(m => ({
                  id: m.id,
                  agentId: m.agent_id,
                  agentName: m.agent_name,
                  agentEmoji: m.agent_emoji,
                  content: m.content,
                  phase: m.phase,
                  timestamp: new Date(m.created_at).toISOString(),
                })),
                escalations: escalations.map(e => ({
                  id: e.id,
                  agentId: e.agent_id,
                  agentName: e.agent_name,
                  agentEmoji: e.agent_emoji,
                  question: e.question,
                  answer: e.answer,
                  status: e.status || 'pending',
                  createdAt: new Date(e.created_at).toISOString(),
                })),
                files: files.map(f => ({
                  name: f.name,
                  type: f.type,
                  size: f.size,
                })),
                createdAt: new Date(session.created_at).toISOString(),
              }, null, 2),
            }],
          };
        }

        case 'warroom_create_session': {
          const { problem, files } = schemas.createSession.parse(args);
          
          // Use the createSession function from server.js
          const session = createSession(problem, files || []);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                sessionId: session.id,
                message: 'Research session created. Deliberation will begin automatically. Poll warroom_get_session to track progress.',
              }, null, 2),
            }],
          };
        }

        case 'warroom_delete_session': {
          const { sessionId } = schemas.deleteSession.parse(args);
          
          db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
          activeSessions.delete(sessionId);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: true, message: `Session ${sessionId} deleted` }),
            }],
          };
        }

        case 'warroom_ask_question': {
          const { sessionId, question } = schemas.askQuestion.parse(args);
          
          const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
          if (!session) {
            throw new Error(`Session ${sessionId} not found`);
          }

          // Load full session context
          const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
          
          // Try to load files (may not exist in older schemas)
          let files = [];
          try {
            files = db.prepare('SELECT * FROM session_files WHERE session_id = ?').all(sessionId);
          } catch (e) {
            // Table doesn't exist
          }
          
          // Build context for Process Architect to answer
          const architect = AGENTS.find(a => a.id === 'process-architect');
          const conversationContext = messages.map(m => `[${m.agent_name}]: ${m.content}`).join('\n\n');
          
          const systemPrompt = architect.systemPrompt + '\n\nYou are now in Q&A mode. Answer the human\'s follow-up question based on the full deliberation context.';
          
          const userPrompt = `ORIGINAL PROBLEM:\n${session.problem}\n\n`;
          const fileContext = files.map(f => `FILE: ${f.name}\n${f.content || '[binary]'}`).join('\n\n');
          
          const fullPrompt = `${userPrompt}${fileContext ? fileContext + '\n\n' : ''}FULL DELIBERATION:\n${conversationContext}\n\nHUMAN FOLLOW-UP QUESTION:\n${question}\n\nProvide a comprehensive answer based on the full context of the research session.`;
          
          // Call LLM
          const response = await callLLM(systemPrompt, [{ role: 'user', content: fullPrompt }], 'process-architect');
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                question,
                answer: response,
                answeredBy: 'Process Architect',
              }, null, 2),
            }],
          };
        }

        case 'warroom_answer_escalation': {
          const { escalationId, answer } = schemas.answerEscalation.parse(args);
          
          const escalation = db.prepare('SELECT * FROM escalations WHERE id = ?').get(escalationId);
          if (!escalation) {
            throw new Error(`Escalation ${escalationId} not found`);
          }

          db.prepare('UPDATE escalations SET status = ?, answer = ?, answered_at = ? WHERE id = ?')
            .run('answered', answer, Date.now(), escalationId);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                escalationId,
                message: 'Escalation answered. The agent will see this in the next phase.',
              }),
            }],
          };
        }

        case 'warroom_get_escalations': {
          const { sessionId, onlyPending } = schemas.getEscalations.parse(args);
          
          let query = 'SELECT e.*, s.problem FROM escalations e JOIN sessions s ON e.session_id = s.id';
          const params = [];
          
          if (sessionId) {
            query += ' WHERE e.session_id = ?';
            params.push(sessionId);
          }
          
          if (onlyPending) {
            query += (sessionId ? ' AND' : ' WHERE') + " e.status = 'pending'";
          }
          
          query += ' ORDER BY e.created_at DESC';
          
          const escalations = db.prepare(query).all(...params);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                escalations: escalations.map(e => ({
                  id: e.id,
                  sessionId: e.session_id,
                  problemExcerpt: e.problem.slice(0, 60) + '...',
                  agentId: e.agent_id,
                  agentName: e.agent_name,
                  agentEmoji: e.agent_emoji,
                  question: e.question,
                  answer: e.answer,
                  status: e.status || 'pending',
                  createdAt: new Date(e.created_at).toISOString(),
                })),
              }, null, 2),
            }],
          };
        }

        case 'warroom_get_messages': {
          const { sessionId, agentId, phase, pinnedOnly } = schemas.getMessages.parse(args);
          
          let query = 'SELECT * FROM messages WHERE session_id = ?';
          const params = [sessionId];
          
          if (agentId) {
            query += ' AND agent_id = ?';
            params.push(agentId);
          }
          
          if (phase) {
            query += ' AND phase = ?';
            params.push(phase);
          }
          
          query += ' ORDER BY created_at ASC';
          
          let messages = db.prepare(query).all(...params);
          
          if (pinnedOnly) {
            messages = messages.filter(m => m.pinned);
          }
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                messages: messages.map(m => ({
                  id: m.id,
                  agentId: m.agent_id,
                  agentName: m.agent_name,
                  agentEmoji: m.agent_emoji,
                  content: m.content,
                  phase: m.phase,
                  pinned: Boolean(m.pinned),
                  timestamp: new Date(m.created_at).toISOString(),
                })),
              }, null, 2),
            }],
          };
        }

        case 'warroom_export_session': {
          const { sessionId } = schemas.exportSession.parse(args);
          
          const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
          if (!session) {
            throw new Error(`Session ${sessionId} not found`);
          }

          const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
          const escalations = db.prepare('SELECT * FROM escalations WHERE session_id = ? ORDER BY created_at ASC').all(sessionId);
          
          let markdown = `# War Room Research Session\n\n`;
          markdown += `**Session ID:** ${session.id}\n`;
          markdown += `**Created:** ${new Date(session.created_at).toLocaleString()}\n`;
          markdown += `**Status:** ${session.active ? 'Active' : 'Completed'}\n\n`;
          markdown += `## Problem Statement\n\n${session.problem}\n\n`;
          
          markdown += `## Deliberation\n\n`;
          let currentPhase = null;
          messages.forEach(m => {
            if (m.phase !== currentPhase) {
              markdown += `### ${m.phase}\n\n`;
              currentPhase = m.phase;
            }
            markdown += `#### ${m.agent_emoji} ${m.agent_name}\n\n`;
            markdown += `${m.content}\n\n`;
          });
          
          if (escalations.length > 0) {
            markdown += `## Escalations\n\n`;
            escalations.forEach(e => {
              markdown += `**Q:** ${e.question}\n`;
              if (e.answered) {
                markdown += `**A:** ${e.answer}\n\n`;
              } else {
                markdown += `*[Pending]*\n\n`;
              }
            });
          }
          
          return {
            content: [{
              type: 'text',
              text: markdown,
            }],
          };
        }

        case 'warroom_search_sessions': {
          const { query } = schemas.searchSessions.parse(args);
          
          const sessions = db.prepare(`
            SELECT DISTINCT s.id, s.problem, s.phase, s.active, s.created_at,
              (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count
            FROM sessions s
            LEFT JOIN messages m ON s.id = m.session_id
            WHERE s.problem LIKE ? OR m.content LIKE ?
            ORDER BY s.created_at DESC
            LIMIT 20
          `).all(`%${query}%`, `%${query}%`);
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                query,
                results: sessions.map(s => ({
                  id: s.id,
                  problem: s.problem.slice(0, 100) + (s.problem.length > 100 ? '...' : ''),
                  phase: PHASES[s.phase]?.name || 'Unknown',
                  status: s.active ? 'active' : 'completed',
                  messageCount: s.message_count,
                  createdAt: new Date(s.created_at).toISOString(),
                })),
              }, null, 2),
            }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: error.message }),
        }],
        isError: true,
      };
    }
  });

    return server;
  }; // End of createServerInstance

  // ─── Mount HTTP Transport ──────────────────────────────────
  
  const transports = {}; // Store transports by session ID and their servers
  
  // Handle all MCP requests
  app.all('/mcp/:apiKey', async (req, res) => {
    const { apiKey } = req.params;
    
    // Validate API key
    if (apiKey !== DEFAULT_API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    try {
      // Check for existing session
      const sessionId = req.headers['mcp-session-id'];
      let transport;
      
      if (sessionId && transports[sessionId]) {
        // Reuse existing transport and server
        transport = transports[sessionId].transport;
      } else if (!sessionId && req.method === 'POST') {
        // Create new server instance for this session
        const serverInstance = createServerInstance();
        
        // Create new transport for initialization
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            console.log(`MCP session initialized: ${sid}`);
            transports[sid] = { transport, server: serverInstance };
          },
        });
        
        // Clean up on close
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
            console.log(`MCP session closed: ${sid}`);
          }
        };
        
        // Connect transport to server
        await serverInstance.connect(transport);
      }
      
      if (transport) {
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({ error: 'No valid session' });
      }
    } catch (error) {
      console.error('MCP request error:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  console.log(`✅ MCP server mounted at /mcp/${DEFAULT_API_KEY}`);
  console.log(`   Tools: warroom_list_sessions, warroom_get_session, warroom_create_session, warroom_delete_session`);
  console.log(`          warroom_ask_question, warroom_answer_escalation, warroom_get_escalations`);
  console.log(`          warroom_get_messages, warroom_export_session, warroom_search_sessions`);
}

module.exports = { setupMCPServer, DEFAULT_API_KEY };
