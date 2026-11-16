import type { ToolAction } from '@mastra/core/tools';

export type ToolReturn = ToolAction<any, any, any, any, any, any>;

export interface AgentToolInterface {
  name: string;
  // needs an MCP host (e.g. renders a ui:// widget), so the in-app agent doesn't get it
  mcpOnly?: boolean;
  // a tool of a feature this install has not configured is left out everywhere
  available?(): boolean;
  // a self-hosted instance without it can still connect through the cloud
  // relay, calling it there asks to update the instance
  optionalOnSelfHosted?: boolean;
  // a reason when this call needs a human (DharaHIL) over MCP, null when it
  // does not; enforced for every tool that sets it (human.approval.ts)
  approval?(args: any, orgId: string): string | null | Promise<string | null>;
  // checks for args a human edited before they run, a reason to refuse or null
  approvalValidate?(args: any, orgId: string): Promise<string | null>;
  // what a gated call is about, however it is worded (see human.approval.ts
  // DecideInput.target): stops duplicate approvals and double runs
  approvalTarget?(args: any): string;
  run(): ToolReturn;
}
