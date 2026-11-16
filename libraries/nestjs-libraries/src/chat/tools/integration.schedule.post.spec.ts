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

const now = Date.parse('2026-11-16T12:00:00Z');
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const post = (type: string, date: string) => ({ type, date });

describe('schedule post approval trigger', () => {
  it('gates publish-now', () => {
    expect(scheduleApproval({ socialPost: [post('now', at(0))] }, now)).toEqual(
      expect.any(String)
    );
  });

  it('gates a scheduled post in the past or within 5 minutes', () => {
    for (const minutes of [-60, 0, 4, 5]) {
      expect(
        scheduleApproval({ socialPost: [post('schedule', at(minutes))] }, now)
      ).toEqual(expect.any(String));
    }
  });

  it('gates a date that does not parse', () => {
    expect(
      scheduleApproval({ socialPost: [post('schedule', 'tomorrow-ish')] }, now)
    ).toEqual(expect.any(String));
  });

  it('does not gate a future date', () => {
    expect(
      scheduleApproval({ socialPost: [post('schedule', at(6))] }, now)
    ).toBeNull();
  });

  it('does not gate drafts, whatever the date', () => {
    expect(
      scheduleApproval({ socialPost: [post('draft', at(-60))] }, now)
    ).toBeNull();
  });

  it('gates the whole call when any one item triggers', () => {
    expect(
      scheduleApproval(
        {
          socialPost: [
            post('schedule', at(600)),
            post('draft', at(0)),
            post('now', at(0)),
          ],
        },
        now
      )
    ).toEqual(expect.any(String));
  });
});
