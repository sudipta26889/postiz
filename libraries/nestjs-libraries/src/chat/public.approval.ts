import { HttpException } from '@nestjs/common';
import {
  approvalGate,
  DecideInput,
} from '@gitroom/nestjs-libraries/chat/human.approval';

// The public REST API side of the approval gate: a pending approval must
// never look like success to a REST client, so a decision becomes an HTTP
// answer (428 pending, 409 already done or unknown, 403 refused, 503 when
// the approval service itself is unavailable).

export const createPublicApproval = (gate = approvalGate) => ({
  run: async <T>(
    input: Omit<DecideInput<T>, 'isNoop' | 'releaseOnError'>
  ): Promise<T> => {
    // A claim is released only for a 404 (the thing is already gone: nothing
    // was done). Any other failure may have written something (a multi-post
    // create), so its approval is used up and a repeat answers 409
    const decision = await gate.decide<T>({
      ...input,
      releaseOnError: (err) =>
        err instanceof HttpException &&
        (err.getStatus() === 404 ||
          (err.getResponse() as any)?.nothingDone === true),
    });

    switch (decision.status) {
      case 'executed':
        return decision.result;
      case 'pending':
        throw new HttpException(
          {
            msg: 'Waiting for human approval in DharaHIL',
            status: 'approval_pending',
            requestId: decision.requestId,
            expiresAt: decision.expiresAt,
            message:
              'Postiz carries it out automatically once a person approves in DharaHIL; repeating the identical request only reports its status',
          },
          428
        );
      case 'done':
      case 'running':
        throw new HttpException({ msg: decision.message }, 409);
      default:
        // the service failed (503), a duplicate of something that exists
        // (409), or a human or the policy said no (403)
        throw new HttpException(
          { msg: decision.message },
          decision.unavailable ? 503 : decision.duplicate ? 409 : 403
        );
    }
  },
});

export const publicApproval = createPublicApproval();
