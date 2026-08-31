import {
  type PhaseBCustomerProfileResponse,
  type PhaseBCustomerWorkflowIntentInput,
  validatePhaseBCustomerWorkflowIntentResponse,
} from "contracts";
import { BffLlmInferenceError, type BffLlmService } from "../data/llm";
import type { WorkflowIntentInputSelection } from "../data/workflow-intent";

type JsonValue = unknown;

const WORKFLOW_INTENT_GENERATED_FROM = "phase-b-wallet-workflow-intent-v1";
const GENERIC_LLM_INFERENCE_ERROR_MESSAGE = "LLM upsell explanation inference failed.";
export const SNAPSHOT_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

const workflowIntentReason = {
  provenance: "derived_insight" as const,
  label: "BFF workflow intent session analysis",
};

export const json = (body: JsonValue, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: {
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });

export const cachedJson = (body: JsonValue, init: ResponseInit = {}) =>
  json(body, {
    ...init,
    headers: {
      "cache-control": SNAPSHOT_CACHE_CONTROL,
      ...(init.headers ?? {}),
    },
  });

export const notFound = (path: string) =>
  json({ error: "not_found", message: `Route not found: ${path}` }, { status: 404 });

export const methodNotAllowed = () =>
  json(
    {
      error: "method_not_allowed",
      message: "The BFF only supports GET for read endpoints.",
    },
    { status: 405, headers: { allow: "GET" } },
  );

export const badRequest = (message: string) =>
  json({ error: "bad_request", message }, { status: 400 });

export const unauthorized = (message = "Missing or invalid authorization.") =>
  json({ error: "unauthorized", message }, { status: 401 });

export const forbidden = (message = "Forbidden.") =>
  json({ error: "forbidden", message }, { status: 403 });

export const rateLimited = (message = "Rate limit exceeded.") =>
  json({ error: "rate_limited", message }, { status: 429 });

export const analyticsLoading = () =>
  json(
    {
      error: "analytics_loading",
      message: "Analytics read model is still loading.",
    },
    { status: 503 },
  );

export const analyticsUnavailable = (message = "Analytics read model is unavailable.") =>
  json(
    {
      error: "analytics_unavailable",
      message,
    },
    { status: 503 },
  );

export const llmUnavailable = () =>
  json(
    {
      error: "llm_unavailable",
      message: "LLM upsell explanation is not configured for this environment.",
    },
    { status: 503 },
  );

export const llmFailed = (error: unknown) =>
  json(
    {
      error: "llm_failed",
      message:
        error instanceof BffLlmInferenceError
          ? error.message
          : error instanceof Error && error.message
            ? error.message
            : GENERIC_LLM_INFERENCE_ERROR_MESSAGE,
    },
    { status: 502 },
  );

type WorkflowIntentResponseInput = {
  address: string;
  profile: PhaseBCustomerProfileResponse;
  selection: WorkflowIntentInputSelection;
  input: PhaseBCustomerWorkflowIntentInput | null;
};

const baseWorkflowIntentResponse = ({
  address,
  profile,
  selection,
  input,
}: WorkflowIntentResponseInput) => ({
  generatedAt: new Date().toISOString(),
  generatedFrom: WORKFLOW_INTENT_GENERATED_FROM,
  address,
  sourceGeneratedAt: profile.generatedAt,
  sessionWindowSeconds: selection.sessionWindowSeconds,
  sessionCount: selection.sessionCount,
  remainingSessionCount: selection.remainingSessionCount,
  input,
  explanations: [],
  sessions: selection.sessions,
  failureMessage: null,
  provenance: "derived_insight" as const,
  provenanceByField: {
    address: "onchain_fact" as const,
    input: "derived_insight" as const,
    sessions: "derived_insight" as const,
  },
  reasons: [workflowIntentReason],
});

export const workflowIntentNoCandidateSessions = (input: WorkflowIntentResponseInput) =>
  json(
    validatePhaseBCustomerWorkflowIntentResponse({
      ...baseWorkflowIntentResponse(input),
      analysisStatus: "no_candidate_sessions",
      model: null,
      input: null,
    }),
  );

export const workflowIntentUnavailable = (input: WorkflowIntentResponseInput) =>
  json(
    validatePhaseBCustomerWorkflowIntentResponse({
      ...baseWorkflowIntentResponse(input),
      analysisStatus: "unavailable",
      model: null,
    }),
  );

export const workflowIntentReady = (
  input: WorkflowIntentResponseInput & {
    input: PhaseBCustomerWorkflowIntentInput;
    result: Awaited<ReturnType<BffLlmService["generateWorkflowIntentExplanation"]>>;
  },
) =>
  json(
    validatePhaseBCustomerWorkflowIntentResponse({
      ...baseWorkflowIntentResponse(input),
      analysisStatus: "ready",
      model: input.result.model,
      explanations: input.result.explanations,
      provenanceByField: {
        address: "onchain_fact",
        model: "derived_insight",
        input: "derived_insight",
        explanations: "derived_insight",
        sessions: "derived_insight",
      },
    }),
  );

export const workflowIntentFailed = (input: WorkflowIntentResponseInput & { error: unknown }) =>
  json(
    validatePhaseBCustomerWorkflowIntentResponse({
      ...baseWorkflowIntentResponse(input),
      analysisStatus: "failed",
      model: null,
      failureMessage:
        input.error instanceof BffLlmInferenceError
          ? input.error.message
          : input.error instanceof Error && input.error.message
            ? input.error.message
            : "Workflow intent explanation inference failed.",
    }),
  );
