import 'reflect-metadata';

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings',
  () => ({ AllProvidersSettings: class {} })
);

import { scheduleApproval } from '@gitroom/nestjs-libraries/chat/tools/integration.schedule.post';

const post = (type: string, date: string) => ({ type, date });
const inAWeek = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

describe('schedule post approval trigger', () => {
  it('gates publish-now', () => {
    expect(scheduleApproval({ socialPost: [post('now', inAWeek)] })).toEqual(
      expect.any(String)
    );
  });

  it('gates a post scheduled far in the future too (nothing is posted without a human)', () => {
    expect(
      scheduleApproval({ socialPost: [post('schedule', inAWeek)] })
    ).toEqual(expect.any(String));
  });

  it('does not gate drafts', () => {
    expect(scheduleApproval({ socialPost: [post('draft', inAWeek)] })).toBeNull();
  });

  it('gates the whole call when any one item would be posted', () => {
    expect(
      scheduleApproval({
        socialPost: [post('draft', inAWeek), post('schedule', inAWeek)],
      })
    ).toEqual(expect.any(String));
  });
});
