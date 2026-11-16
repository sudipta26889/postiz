import { HttpException } from '@nestjs/common';
import {
  approvalGate,
  DecideInput,
} from '@gitroom/nestjs-libraries/chat/human.approval';

// The public REST API side of the approval gate: a pending approval must
// never look like success to a REST client, so a decision becomes an HTTP
// answer (428 pending, 409 already done or unknown, 403 refused).

export const createPublicApproval = (gate = approvalGate) => ({
  run: async <T>(
    input: Omit<DecideInput<T>, 'isNoop' | 'releaseOnError'>
  ): Promise<T> => {
    const decision = await gate.decide<T>({
      ...input,
      // a 4xx from the action is a validation or lookup failure, before any
      // side effect: the approved call can be repeated
      releaseOnError: (err) =>
        err instanceof HttpException && err.getStatus() < 500,
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
            message: 'Repeat the identical request after approval in DharaHIL',
          },
          428
        );
      case 'done':
      case 'running':
        throw new HttpException({ msg: decision.message }, 409);
      default:
        throw new HttpException({ msg: decision.message }, 403);
    }
  },
});

export const publicApproval = createPublicApproval();
