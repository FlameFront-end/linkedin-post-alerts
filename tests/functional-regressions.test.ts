import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify,
  languageMatch,
  vacancyRoles,
  vacancyCandidates,
} from '../packages/contracts/src/classifier.js';
import type { Post } from '../packages/contracts/src/index.js';

const post = (text: string, extra: Partial<Post> = {}): Post => ({
  id: 'test-post',
  url: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
  author: 'Recruiter',
  text,
  publishedAt: new Date().toISOString(),
  firstSeenAt: new Date().toISOString(),
  ...extra,
});
for (const sentence of [
  'We do not require Russian.',
  "We don't require Russian.",
  'You do not need to speak fluent Russian.',
  'Russian is not mandatory.',
  'No need to speak Russian.',
  'Russian is preferred.',
  'Russian or Ukrainian required.',
])
  test(`Russian is not mandatory: ${sentence}`, () =>
    assert.equal(languageMatch(sentence), 'none'));
for (const sentence of [
  'Frontend Engineer (Russian-speaking)',
  'Russian-speaking Frontend Engineer',
  'Fluent Russian required',
  'Russian required, English optional',
])
  test(`Russian is mandatory: ${sentence}`, () =>
    assert.equal(languageMatch(sentence), 'required'));
for (const text of [
  'Frontend разработчик, рассматриваю вакансии. Есть опыт работы в продуктовой команде, готов обсудить условия и задачи.',
  'Курс Frontend для начинающих. Разбираем вакансии и готовимся к собеседованиям. Занятия в группе, опыт не нужен, скидка на обучение.',
  'Ищем Backend разработчика в нашу команду. Обязанности: разработка серверных сервисов, взаимодействие с frontend командой. Предлагаем удаленную работу и гибкий график.',
])
  test(`Reject non-target publication: ${text.slice(0, 45)}`, () =>
    assert.deepEqual(vacancyRoles(classify(text)), []));
test('Generic job title falls back to actual frontend responsibilities', () =>
  assert.deepEqual(
    vacancyRoles(
      classify(
        'Ищем разработчика в нашу команду. Основные задачи: разработка frontend на React, создание интерфейсов, работа с API.',
        { title: 'Software Engineer', listing: true },
      ),
    ),
    ['frontend'],
  ));
test('Roundup keeps open frontend role when backend role is closed', () => {
  const value = post(
    'Ищем разработчиков в нашу команду.\nBackend: вакансия закрыта.\nFrontend: открыта позиция, удаленная работа, опыт от трех лет.',
  );
  const candidates = vacancyCandidates(value);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.post.title, 'Frontend');
  assert.deepEqual(vacancyRoles(classify(value.text)), ['frontend']);
});
test('Language requirement does not leak from a different role in a roundup', () => {
  const value = post(
    'We are hiring!\nBackend Engineer: Fluent Russian required.\nFrontend Engineer: English only. Build interfaces with React.',
  );
  assert.equal(vacancyCandidates(value).length, 0);
});
test('Hiring post addressing candidates is still a vacancy', () =>
  assert.deepEqual(
    vacancyRoles(
      classify(
        'Ищем frontend разработчика в нашу команду. Если вы ищете работу, отправляйте резюме. Предлагаем гибкие условия и интересные задачи.',
      ),
    ),
    ['frontend'],
  ));

for (const text of [
  'Rust Engineer (Low-Latency Trading Systems)\nМы ищем инженера. Работа с торговыми движками и Rust. Взаимодействие с full-stack командой.',
  'Ищем Golang-разработчика. Работа удалённо. Обязанности: серверные сервисы и интеграция с frontend.',
  'Открыта вакансия Middle Fullstack QA. Работа удалённо. Опыт автоматизации тестирования.',
  'Role: Billing Intake Coordinator (Front-End)\nИщем специалиста по обработке счетов. Опыт работы и удалённый формат.',
  'I’m hiring a Brand Manager in Canada!\nИщем сотрудника для работы с кампаниями и frontend командой. Удалённо.',
]) {
  test(`Reject incidental role matches: ${text.split('\n')[0]}`, () => {
    assert.deepEqual(vacancyRoles(classify(text)), []);
  });
}

test('A Russian requirement in another listing cannot qualify a frontend entry', () => {
  const roundup = post(
    'New jobs in Egypt and Gulf\n🔹 Full Stack Developer | Example company\n🇷🇺 🔹 Aesthetic Doctor – Russian Speaking | Clinic\n🔹 Frontend Engineer | Another company',
  );
  assert.deepEqual(vacancyCandidates(roundup), []);
});

test('Translated medical roundup does not qualify an English-language developer listing', () => {
  const roundup = post(
    'Новые рабочие места в регионе\n🔹 Full Stack разработчик (переезд в Александрию) | Example company\n🔹 Врач | Клиника предлагает работу, опыт от трёх лет',
  );
  assert.deepEqual(vacancyCandidates(roundup), []);
});

test('Roundup keeps the entry with a local Russian requirement', () => {
  const roundup = post(
    'New jobs in Egypt and Gulf\n🔹 Full Stack Developer | Example company\n🔹 Frontend Engineer | Fluent Russian required\n🔹 Aesthetic Doctor | Clinic',
  );
  const candidates = vacancyCandidates(roundup);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.post.title, 'Frontend Engineer');
  assert.equal(candidates[0]!.decision.language, 'required');
});

test('Frontend vacancy can mention Rust services and the QA team', () => {
  assert.deepEqual(
    vacancyRoles(
      classify(
        'Ищем frontend разработчика для интеграции с Rust API и работы с QA командой. Удалённо, опыт от трёх лет.',
      ),
    ),
    ['frontend'],
  );
});

test('Salary is read from a single line, preserving the entire range', async () => {
  const { vacancyFacts } = await import('../packages/contracts/src/facts.js');
  assert.equal(
    vacancyFacts(post('Пересечение с UTC+3\n4000–5500 USD\nОпыт от 3 лет'))
      .salary,
    '4000–5500 USD',
  );
  assert.equal(
    vacancyFacts(post('Expected Salary: $70K-$80K per year')).salary,
    '$70K-$80K',
  );
  assert.equal(
    vacancyFacts(post('Статья: сервис стоит $9.51 в месяц.')).salary,
    undefined,
  );
});
