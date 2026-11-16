import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { canonicalJson } from '@gitroom/nestjs-libraries/chat/human.approval';

@Injectable()
export class PostSettingsTool implements AgentToolInterface {
  constructor(private _postsService: PostsService) {}
  name = 'postSettingsTool';

  // only a scheduled (QUEUE) post's settings change what goes out, so only
  // those ask a human (DharaHIL); drafts are free, and the tool refuses any
  // other state itself instead of paging a person for nothing
  approvalTarget = (args: { id: string; settings?: unknown }) =>
    `post:${args.id}:settings:${canonicalJson(args.settings ?? null)}`;

  approval = async (args: { id: string }, orgId: string) => {
    const snapshot = await this._postsService.approvalSnapshot(orgId, args.id);
    return snapshot.state !== 'QUEUE'
      ? null
      : `Changing the settings of a scheduled post: "${snapshot.preview}"`;
  };

  run() {
    return createTool({
      id: 'postSettingsTool',
      mcp: {
        annotations: {
          title: 'Update Post Settings',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      description: `
Update the provider settings of an existing post (scheduled or draft) that was NOT published yet.
Only the settings change - the content and the publish date stay exactly as they are.
Find the post first (list your posts) and pass its "id" here.
The settings are merged into the existing ones, so only pass the keys you want to change; anything you don't pass stays as it is.
This relies on the integrationSchema tool [input:settings] to know which keys exist for the platform.
If validation fails, the result contains output.errors describing what to fix; the call can be retried with corrected parameters.
`,
      inputSchema: z.object({
        id: z
          .string()
          .describe('The "id" of the post to update its settings'),
        settings: z
          .array(
            z.object({
              key: z.string().describe('Name of the settings key to change'),
              value: z
                .any()
                .describe(
                  'New value of the key, always prefer the id then label if possible. When the settings schema says a field is an id, pass the id returned by the channel tools, never the display label'
                ),
            })
          )
          .describe(
            'Settings keys to change, merged into the existing settings. This relies on the integrationSchema tool [input:settings]'
          ),
      }),
      outputSchema: z.object({
        output: z
          .object({
            postId: z.string(),
            publishDate: z.string(),
          })
          .or(z.object({ errors: z.string() })),
      }),
      execute: async (inputData, context) => {
        checkAuth(inputData, context);
        const organizationId = JSON.parse(
          (context?.requestContext as any)?.get('organization') as string
        ).id;

        const settings = (inputData.settings || []).reduce(
          (acc: Record<string, any>, s: { key: string; value: any }) => ({
            ...acc,
            [s.key]: s.value,
          }),
          {} as Record<string, any>
        );

        try {
          const output = await this._postsService.updatePostSettings(
            organizationId,
            inputData.id,
            settings,
            'MCP'
          );

          return { output };
        } catch (err: any) {
          return {
            output: {
              errors: err?.message || 'Failed to update the post settings',
            },
          };
        }
      },
    });
  }
}
