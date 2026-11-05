import { MockSource } from '../services/collector/src/sources/mock.js';
import { classify } from '../services/processor/src/classifier.js';
import { formatNotification } from '../services/notifier/src/format.js';
for (const post of await new MockSource().fetchPosts()) {
  const decision = classify(post.text);
  if (decision.roles.length)
    console.log(
      formatNotification(
        { post, roles: decision.roles, russian: decision.russian },
        true,
      ),
    );
  else console.log(`Skipped ${post.id}: ${decision.reason}`);
}
