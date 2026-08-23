// F5 — Input validation. Every WS message and every HTTP body that mutates
// state goes through a zod schema before reaching handler logic. The
// validateWS dispatcher is exhaustive: every msg.type that ws-handler.js
// switches on must have an entry here, otherwise the message is rejected
// with {type:'error', code:'INVALID_MSG'}.

const { z } = require('zod');

// Hard caps from spec §F5.
const MAX_PROBLEM = 50_000;
const MAX_HUMAN_MSG = 10_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_NAME = 255;

const fileIdSchema = z.string().min(1).max(MAX_NAME);

// ─── WebSocket schemas ───────────────────────────────────────
const wsNewSessionSchema = z.object({
  type: z.literal('new-session'),
  problem: z.string().min(1).max(MAX_PROBLEM),
  file_ids: z.array(fileIdSchema).max(MAX_FILES).optional(),
  preset_id: z.enum(['engineer', 'scientist']).nullish(),
  continuesFromSessionId: z.string().min(1).max(MAX_NAME).nullish(),
});

const wsEscalationResponseSchema = z.object({
  type: z.literal('escalation-response'),
  sessionId: z.string().min(1).max(MAX_NAME),
  escalationId: z.string().min(1).max(MAX_NAME),
  answer: z.string().max(MAX_HUMAN_MSG),
});

const wsHumanMessageSchema = z.object({
  type: z.literal('human-message'),
  sessionId: z.string().min(1).max(MAX_NAME),
  content: z.string().min(1).max(MAX_HUMAN_MSG),
});

const wsJoinSessionSchema = z.object({
  type: z.literal('join-session'),
  sessionId: z.string().min(1).max(MAX_NAME),
});

const wsStopSessionSchema = z.object({
  type: z.literal('stop-session'),
  sessionId: z.string().min(1).max(MAX_NAME),
});

const wsEscalationBulkResolveSchema = z.object({
  type: z.literal('escalation-bulk-resolve'),
  sessionId: z.string().min(1).max(MAX_NAME),
});

// HLB-148: control the per-escalation countdown. `pause` suspends the
// auto-resolve deadline; `resume` continues from the time left at pause; `reset`
// restarts a fresh full window from now. Strict: unknown ops are rejected.
const wsEscalationTimerSchema = z.object({
  type: z.literal('escalation-timer'),
  sessionId: z.string().min(1).max(MAX_NAME),
  escalationId: z.string().min(1).max(MAX_NAME),
  op: z.enum(['pause', 'resume', 'reset']),
});

const wsResumeSessionSchema = z.object({
  type: z.literal('resume-session'),
  sessionId: z.string().min(1).max(MAX_NAME),
});

const wsDeleteSessionSchema = z.object({
  type: z.literal('delete-session'),
  sessionId: z.string().min(1).max(MAX_NAME),
});

const wsGetSessionsSchema = z.object({
  type: z.literal('get-sessions'),
});

const wsSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  sessionId: z.string().min(1).max(MAX_NAME),
});

const wsUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  sessionId: z.string().min(1).max(MAX_NAME),
});

const WS_SCHEMAS = {
  'new-session': wsNewSessionSchema,
  'escalation-response': wsEscalationResponseSchema,
  'escalation-bulk-resolve': wsEscalationBulkResolveSchema,
  'escalation-timer': wsEscalationTimerSchema,
  'human-message': wsHumanMessageSchema,
  'join-session': wsJoinSessionSchema,
  'stop-session': wsStopSessionSchema,
  'resume-session': wsResumeSessionSchema,
  'delete-session': wsDeleteSessionSchema,
  'get-sessions': wsGetSessionsSchema,
  'subscribe': wsSubscribeSchema,
  'unsubscribe': wsUnsubscribeSchema,
};

// Dispatcher: pick schema by msg.type, run safeParse, return canonical shape.
function validateWS(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { ok: false, error: 'missing or invalid msg.type' };
  }
  const schema = WS_SCHEMAS[msg.type];
  if (!schema) {
    return { ok: false, error: `unknown message type: ${msg.type}` };
  }
  const result = schema.safeParse(msg);
  if (!result.success) {
    return { ok: false, error: result.error.issues };
  }
  return { ok: true, data: result.data };
}

// ─── HTTP body schemas ───────────────────────────────────────
const httpCreateSessionBody = z.object({
  problem: z.string().min(1).max(MAX_PROBLEM),
  file_ids: z.array(fileIdSchema).max(MAX_FILES).optional(),
  preset_id: z.enum(['engineer', 'scientist']).nullish(),
  continuesFromSessionId: z.string().min(1).max(MAX_NAME).nullish(),
});

const httpAttachFilesBody = z.object({
  file_ids: z.array(fileIdSchema).min(1).max(MAX_FILES),
});

const httpResumeSessionBody = z.object({}).optional();

const httpImproveBody = z.object({
  problem: z.string().min(1).max(MAX_PROBLEM),
});

const httpPinBody = z.object({
  pinned: z.union([z.boolean(), z.literal(0), z.literal(1)]),
});

// Settings-panel connection probe. Route ids mirror app-config ROUTES; the
// empty string means "this deployment's default provider". Model length cap
// matches the agent-routing PUT.
const { ROUTES } = require('./app-config');
const httpTestConnectionBody = z.object({
  route: z.string().max(40).optional().default('')
    .refine(v => v === '' || ROUTES.includes(v), { message: 'unknown route' }),
  model: z.string().trim().max(200).optional().default(''),
});

// Agent-routing write. `force` persists a candidate the preflight dry run
// rejected: the operator has read the failures and is configuring ahead of a
// provider that is down. Absent, a failed dry run blocks the write.
const routingEntrySchema = z.object({
  route: z.string().max(40).nullish(),
  model: z.string().max(200).nullish(),
}).nullable();

const httpAgentRoutingBody = z.object({
  routing: z.record(z.string().max(MAX_NAME), routingEntrySchema),
  force: z.boolean().optional().default(false),
  skipPreflight: z.boolean().optional().default(false),
});

// Standalone dry run. Omit `routing` to check what is already stored.
const httpPreflightBody = z.object({
  routing: z.record(z.string().max(MAX_NAME), routingEntrySchema).optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(),
});

module.exports = {
  validateWS,
  WS_SCHEMAS,
  wsNewSessionSchema,
  wsEscalationResponseSchema,
  wsEscalationBulkResolveSchema,
  wsEscalationTimerSchema,
  wsHumanMessageSchema,
  wsJoinSessionSchema,
  wsStopSessionSchema,
  wsResumeSessionSchema,
  wsDeleteSessionSchema,
  wsGetSessionsSchema,
  wsSubscribeSchema,
  wsUnsubscribeSchema,
  httpCreateSessionBody,
  httpAttachFilesBody,
  httpResumeSessionBody,
  httpImproveBody,
  httpPinBody,
  httpTestConnectionBody,
  httpAgentRoutingBody,
  httpPreflightBody,
};
