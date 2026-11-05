import type { PostSource } from './source.js';
import type { Post } from '../../../../packages/contracts/src/index.js';

export class MockSource implements PostSource {
  readonly name = 'mock';
  async fetchPosts(): Promise<Post[]> {
    const now = new Date().toISOString();
    return [
      {
        id: 'mock-frontend-1',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000001/',
        author: 'DEMO Recruiter',
        text: 'Ищем Frontend React разработчика в команду. Удалённо, от 3000 USD.',
        publishedAt: '2026-11-05T00:00:00.000Z',
        firstSeenAt: now,
      },
      {
        id: 'mock-devops-1',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000002/',
        author: 'DEMO Recruiter',
        text: 'Открыта вакансия DevOps инженера. Kubernetes, Terraform. Remote.',
        publishedAt: '2026-11-05T00:00:00.000Z',
        firstSeenAt: now,
      },
      {
        id: 'mock-candidate-1',
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:1000000000000000003/',
        author: 'DEMO Candidate',
        text: 'Я frontend разработчик. Ищу работу, React и TypeScript.',
        publishedAt: '2026-11-05T00:00:00.000Z',
        firstSeenAt: now,
      },
    ];
  }
}
