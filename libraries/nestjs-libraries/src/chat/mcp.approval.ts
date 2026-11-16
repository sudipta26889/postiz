import {
  approvalGate,
  ApprovalGuard,
} from '@gitroom/nestjs-libraries/chat/human.approval';
import {
  getAuth,
  getContext,
} from '@gitroom/nestjs-libraries/chat/async.storage';

// The MCP side of the approval gate: turns a decision into a tool result
// (a notice the agent can read) or an error (isError).

export interface WithApprovalOptions {
  toolName: string;
  // a reason when this call needs a human, null when it does not
  approval: (args: any, orgId: string) => string | null | Promise<string | null>;
  // extra checks on args a human edited, a reason to refuse or null
  validate?: (args: any, orgId: string) => Promise<string | null> | string | null;
  guard?: ApprovalGuard;
  execute: (inputData: any, context: any) => Promise<any>;
}

// A result every gated tool's outputSchema accepts: { output: { errors } }
const notice = (message: string) => ({ output: { errors: message } });

const orgOf = (context: any): string => {
  const org = context?.mcp?.extra?.authInfo?.id || getAuth()?.id;
  if (!org) {
    throw new Error('Approval needs an authenticated organization');
  }
  return org;
};

export const createMcpApproval = (gate = approvalGate) => ({
  withApproval:
    (opts: WithApprovalOptions) => async (inputData: any, context: any) => {
      // fail closed: only the in-app chat is trusted without a human (a
      // signed-in person is there). It is recognised by either marker, so a
      // lost async context can't break it: the async 'app' surface, or the
      // Mastra request context the copilot controller hands every tool
      // (ui = 'true', set nowhere else). An MCP call is never trusted.
      const surface = getContext()?.surface;
      const inApp =
        surface === 'app' ||
        (surface !== 'mcp' && context?.requestContext?.get?.('ui') === 'true');
      if (inApp) {
        return opts.execute(inputData, context);
      }

      const org = orgOf(context);
      const reason = await opts.approval(inputData, org);
      if (reason === null) {
        return opts.execute(inputData, context);
      }

      const decision = await gate.decide({
        action: opts.toolName,
        org,
        args: inputData,
        reason,
        validate: opts.validate,
        guard: opts.guard,
        execute: (args) => opts.execute(args, context),
        // a tool answering with errors did nothing: the claim is released
        isNoop: (result) => !!result?.output?.errors,
      });

      switch (decision.status) {
        case 'executed':
          return decision.result;
        case 'refused':
          throw new Error(decision.message);
        default:
          return notice(decision.message);
      }
    },
});

export const mcpApproval = createMcpApproval();
