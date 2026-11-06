import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  vacancyRoles,
} from '../services/processor/src/classifier.js';

for (const [text, expected] of [
  ['Ищем Frontend React разработчика', ['frontend']],
  ['Открыта вакансия DevOps инженера', ['devops']],
  ['We are hiring a Site Reliability Engineer', ['devops']],
  ['Ищем фронтенд и DevOps инженеров', ['frontend', 'devops']],
  ['Я React разработчик, ищу работу', []],
  ['DevOps engineer open to work', []],
  ['ВАКАНСИЯ ЗАКРЫТА. Ищем React разработчика', []],
  ['Разбираю React hooks в новой статье', []],
  ['Ищем бухгалтера', []],
] as const)
  test(text, () => assert.deepEqual(classify(text).roles, expected));
test('Russian is a preference marker, not a geographic inference', () => {
  assert.equal(classify('Ищем инженера DevOps в команду').russian, true);
  assert.equal(classify('Hiring DevOps').russian, false);
});

test('Live vacancies require Russian text and a frontend or full-stack role', () => {
  assert.deepEqual(
    vacancyRoles(
      classify('Ищем Full-stack разработчика в продуктовую команду'),
    ),
    ['fullstack'],
  );
  assert.deepEqual(
    vacancyRoles(classify('Ищем Vue разработчика в продуктовую команду')),
    ['frontend'],
  );
  assert.deepEqual(
    vacancyRoles(
      classify('Ищем DevOps инженера в команду. React в инфраструктуре.'),
    ),
    [],
  );
  assert.deepEqual(
    vacancyRoles(
      classify(
        'Hiring a frontend engineer for our product team. Русский язык.',
      ),
    ),
    [],
  );
});
