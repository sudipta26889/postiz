# Approval preview: approve the real post, from its Postiz preview link

## Problem

A DharaHIL approval for "publish/schedule a post" shows only text. The owner wants a link that opens what will
actually go out: the text per channel, the thread, the images, and playable video. The gate stops the call
*before* any post exists, so no Postiz preview can exist either.

## Decision

**Draft first, approve the draft.** When a gated call would create new posts (MCP `integrationSchedulePostTool`,
REST `POST /public/v1/posts` with type `schedule` or `now`), the gate:

1. **Validates the call as a real post** (too long, settings, media), the same as when it is scheduled. A post
   that couldn't be scheduled is refused now, not after approval.
2. **Saves it as a DRAFT** (`createPost` with type `draft`). This is the "staged draft". Drafts never post.
3. **Records** for each staged root post `{ postId, hash, schedule }`, where `hash` = `approvalSnapshot(...).hash`
   (content, settings, media, date, channel, state of the whole thread).
4. **Files the DharaHIL request** with `tool_args = { ...original args, staged }`. The card gets one link per
   channel: `${FRONTEND_URL}/p/<postId>?share=true`, the existing public preview page (players for video).
   - `display_hints.sections[0].fields[*]` are `type: "url"`; their values are in `tool_args_redacted`.
   - The links are also appended to `context_summary` (Slack/Telegram).
5. **On approval** (sweep or repeated call), the executor sees `args.staged`. It checks every staged draft still
   exists, is still DRAFT, and has the same hash; then it moves each one with `schedule: true` to QUEUE
   (`changePostStatus(..., 'schedule')`). If any check fails, nothing is scheduled and the request is refused
   ("the draft changed after it was sent for approval"). What was previewed is what goes out.
   - **Late approval.** A post scheduled for a time that has already passed (5 minutes of grace) is never posted
     on approval, because it could go out hours late. The request is refused, the draft stays a draft, and the
     organization is told to set a new time. A post the agent asked to publish **now** (`now: true`) goes out on
     approval.
   - Each link's label shows the channel and the planned time in UTC, so the approver sees it.
   - These refusals carry `nothingDone: true`. The gate releases the claim and reports "nothing was done",
     including from the sweep.
6. **On rejection or expiry**, the staged draft stays a draft. The organization can fix it in Postiz and schedule
   it there (a person in the UI is not gated).

**Idempotency.** The staging result is kept in Redis under `hil:stage:<request key>`. An identical call reuses
it, and so never makes a second draft, as long as the staged drafts are still DRAFT with the same hash.
Otherwise it stages again. Joining an identical waiting request stages nothing.

**Not staged (unchanged flow, link only):**
- REST create calls that edit existing posts (any `value[].id` that exists). Staging would turn a scheduled post
  into a draft while waiting.
- `PUT /posts/:id/status` (draft → schedule), `public.posts.settings` and `public.posts.delete` (single id). The
  post exists, so the card links to it as it is now.

**Safety.**
- `staged` is stripped from every incoming call (REST body, MCP input). Only the gate sets it, and only the
  approved executor reads it. An agent can't make Postiz schedule an arbitrary draft by sending `staged` itself.
- Requests filed before this change have no `staged`; they run as before.
- Edits a person makes to the arguments in DharaHIL are not applied to a staged draft. To change the content,
  edit the draft in Postiz and file again. The hash check then refuses the old approval.

## Generic shape (no provider or route logic in the gate)

- `DecideInput.preview?(args, org, previous) => Promise<{ args, links } | null>`. The gate calls it once per
  new request (not when joining) and stores the result; `links` = `{ label, url }[]`.
- `read()` executes `approved_args ?? stored pending args ?? stored staging args ?? caller args`.
- PostsService:
  - `approvalStage(orgId, roots)` returns `staged[]`;
  - `approvalStageValid(orgId, staged)` returns a boolean;
  - `approvalScheduleStaged(orgId, staged)` checks, then schedules;
  - `approvalPreviewLink(postId)`.
- MCP: an optional tool hook `approvalPreview(args, orgId, previous)` and `approvalExecute(args, orgId)`;
  `load.tools.service` routes approved args that carry `staged` to `approvalExecute`.

## Checks (definition of done)

1. A spec shows the gate files `tool_args.staged`, `display_hints` url fields and the links in the summary, and
   that an identical call doesn't stage twice.
2. A spec shows the executor schedules only staged drafts whose hash is unchanged, and refuses all of them
   otherwise.
3. A spec shows `staged` sent by a caller is ignored.
4. All existing approval specs pass.
5. Production: from claude.ai, scheduling a post creates a DharaHIL request whose card shows a working preview
   link (it opens the draft, with media), and nothing is queued. The owner rejects it, and the draft stays a
   draft.
