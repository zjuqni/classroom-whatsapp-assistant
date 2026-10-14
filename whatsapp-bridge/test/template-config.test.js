'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(overrides = {}, localDates = {}) {
  const properties = {
    VERTEX_PROJECT_ID: 'example-project', VERTEX_MODEL: 'example-model',
    WA_BRIDGE_URL: 'https://bridge.example.invalid', WA_BRIDGE_TOKEN: 'x'.repeat(32),
    WA_BOT_GROUP_ID: 'example-group@g.us', ...overrides
  };
  const calls = [];
  const ctx = {
    console: { log() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] || null }) },
    Utilities: {
      formatDate(date, zone, pattern) {
        const fields = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
          timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(date).map(p => [p.type, p.value]));
        const iso = `${fields.year}-${fields.month}-${fields.day}`;
        const time = `${fields.hour}:${fields.minute}`;
        if (pattern === 'yyyy-MM-dd HH:mm') return `${iso} ${time}`;
        assert.equal(pattern, 'yyyy-MM-dd|dd/MM/yyyy|HH:mm');
        return `${iso}|${fields.day}/${fields.month}/${fields.year}|${time}`;
      },
      // Explicit independent fixtures stand in for Google's timezone-aware parser.
      parseDate(text, zone, pattern) {
        calls.push({ text, zone, pattern });
        const key = `${zone}|${text}`;
        assert.ok(localDates[key], `Missing parseDate fixture: ${key}`);
        return new Date(localDates[key]);
      }
    }
  };
  vm.createContext(ctx);
  for (const file of ['TemplateConfig.gs', 'Notificador.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../apps-script', file), 'utf8'), ctx);
  }
  return { ctx, properties, calls };
}

test('defaults contain no subjects, schedule, personal timezone, or course IDs', () => {
  const { ctx } = setup();
  const settings = ctx.validateTemplateConfiguration();
  assert.equal(settings.timeZone, 'Etc/UTC');
  assert.equal(settings.responseLanguage, 'English');
  assert.equal(settings.pollingIntervalMinutes, 15);
  assert.equal(JSON.stringify(settings.subjectAliases), '{}');
  assert.equal(JSON.stringify(settings.weeklySchedule), '{}');
  assert.equal(JSON.stringify(settings.periodStartTimes), '{}');
  assert.equal(JSON.stringify(settings.courseIds), '[]');
  assert.equal(ctx.NF_materia_('Any course'), '');
  assert.equal(ctx.NF_siguienteClase_('Any subject', '2026-01-01T00:00:00Z'), null);
  assert.match(ctx.NF_comprobarHorario_('Any subject', Date.now()), /No weekly schedule is configured/);
});

test('invalid and placeholder configuration is rejected before installation', () => {
  for (const [overrides, expected] of [
    [{ VERTEX_PROJECT_ID: 'YOUR_PROJECT' }, /VERTEX_PROJECT_ID/],
    [{ WA_BRIDGE_TOKEN: 'short' }, /at least 32/],
    [{ WA_BRIDGE_URL: 'http://example.invalid' }, /HTTPS/],
    [{ POLL_INTERVAL_MINUTES: '7' }, /POLL_INTERVAL_MINUTES/],
    [{ DATE_ONLY_DUE_TIME: '24:00' }, /HH:mm/],
    [{ CLASSROOM_COURSE_IDS_JSON: '[1]' }, /array of string/],
    [{ SUBJECT_ALIASES_JSON: 'invalid' }, /valid JSON/],
    [{ WEEKLY_SCHEDULE_JSON: '[]' }, /must be an object/],
    [{ WEEKLY_SCHEDULE_JSON: '{"Example":{"1":["P1"]}}' }, /aliases/],
    [{ SUBJECT_ALIASES_JSON: '{"Example":["sample"]}', WEEKLY_SCHEDULE_JSON: '{"Example":{"1":["P1"]}}' }, /Missing start time/]
  ]) {
    assert.throws(() => setup(overrides).ctx.instalarNotificador(), expected);
  }
});

test('publication and official due times use the selected timezone, including half-hour offsets', () => {
  const { ctx } = setup({ APP_TIMEZONE: 'Asia/Kolkata' });
  assert.equal(ctx.NF_publicadoVisible_('2026-10-10T18:00:00Z'), 'Saturday 10/10/2026 at 23:30 (Asia/Kolkata)');
  const post = { dueDate: { year: 2026, month: 10, day: 10 }, dueTime: { hours: 20 } };
  assert.equal(ctx.NF_fechaEpoch_(post), Date.parse('2026-10-10T20:00:00Z'));
  assert.equal(ctx.NF_fecha_(post), 'Sunday 11/10/2026 at 01:30 (Asia/Kolkata)');
});

test('text deadlines and date-only fallbacks retain the intended local calendar day', () => {
  const { ctx, calls } = setup({ APP_TIMEZONE: 'Asia/Kolkata', DATE_ONLY_DUE_TIME: '21:00' }, {
    'Asia/Kolkata|2026-10-10 21:00': '2026-10-10T15:30:00Z'
  });
  const result = ctx.NF_calcularVencimiento_({ curso: 'Example', fechaOficialEpoch: 0 }, { tipoFecha: 'EXACTA', fechaISO: '2026-10-10' });
  assert.equal(result.epoch, Date.parse('2026-10-10T15:30:00Z'));
  assert.match(result.fechaTexto, /Saturday 10\/10\/2026.*21:00 Asia\/Kolkata/);
  assert.equal(ctx.NF_fechaEpoch_({ dueDate: { year: 2026, month: 10, day: 10 } }), result.epoch);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].zone, 'Asia/Kolkata');
});

test('custom subject aliases, period sorting, and DST transitions drive next-class inference', () => {
  const { ctx } = setup({
    APP_TIMEZONE: 'America/New_York',
    SUBJECT_ALIASES_JSON: '{"Example Subject":["sample course"]}',
    WEEKLY_SCHEDULE_JSON: '{"Example Subject":{"1":["late","early"]}}',
    CLASS_PERIOD_TIMES_JSON: '{"early":"08:30","late":"11:00"}'
  }, { 'America/New_York|2026-03-09 08:30': '2026-03-09T12:30:00Z' });
  ctx.validateTemplateConfiguration();
  assert.equal(ctx.NF_materia_('SAMPLE COURSE - group A'), 'Example Subject');
  assert.equal(ctx.NF_materia_('Unrelated course'), '');
  assert.equal(JSON.stringify(ctx.NF_periodos_('Example Subject', 1)), '["early","late"]');
  const next = ctx.NF_siguienteClase_('Example Subject', '2026-03-06T20:00:00Z');
  assert.equal(next.epoch, Date.parse('2026-03-09T12:30:00Z'));
  assert.equal(next.hora, '08:30');
  assert.match(ctx.NF_comprobarHorario_('Example Subject', Date.parse('2026-03-10T12:00:00Z')), /No Example Subject class is scheduled/);
});

test('ambiguous course aliases cannot fabricate a subject match', () => {
  const { ctx } = setup({ SUBJECT_ALIASES_JSON: '{"One":["sample"],"Two":["course"]}' });
  assert.equal(ctx.NF_materia_('Sample course'), '');
});

test('publication listing follows every Classroom page', () => {
  const { ctx } = setup();
  const calls = [];
  ctx.Classroom = { Courses: { CourseWork: { list: (courseId, options) => {
    calls.push({ courseId, token: options.pageToken || '' });
    return options.pageToken
      ? { courseWork: [{ id: 'second' }] }
      : { courseWork: [{ id: 'first' }], nextPageToken: 'page-2' };
  } } } };
  ctx.NF_comprobarTiempo_ = () => {};
  const publications = ctx.NF_publicaciones_('example-course', 'Tarea', Date.now() + 10000);
  assert.deepEqual(Array.from(publications, post => post.id), ['first', 'second']);
  assert.deepEqual(calls, [{ courseId: 'example-course', token: '' }, { courseId: 'example-course', token: 'page-2' }]);
});

test('installer creates the configured interval and records history without delivery', () => {
  const { ctx } = setup({ POLL_INTERVAL_MINUTES: '30' });
  const state = {};
  const store = { getProperties: () => state, setProperty: (k, v) => { state[k] = v; }, deleteProperty: k => { delete state[k]; } };
  ctx.PropertiesService.getUserProperties = () => store;
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.NF_cursos_ = () => [{ id: 'example', name: 'Example course' }];
  ctx.NF_publicaciones_ = () => [];
  ctx.NF_activadores_ = () => [];
  ctx.NF_whatsappEnviar_ = () => assert.fail('Installation must not send messages');
  let interval;
  const trigger = { timeBased() { return this; }, everyMinutes(n) { interval = n; return this; }, create: () => ({ getUniqueId: () => 'example-trigger' }) };
  ctx.ScriptApp = { newTrigger: () => trigger, deleteTrigger() {} };
  ctx.instalarNotificador();
  assert.equal(interval, 30);
  assert.equal(state.NF_V1_ACTIVO, 'true');
});

test('new dated publications persist reminder records without replaying the notice', () => {
  const { ctx } = setup();
  const state = { NF_V1_ACTIVO: 'true' };
  const store = { getProperties: () => state, setProperty: (k, v) => { state[k] = v; }, deleteProperty: k => { delete state[k]; } };
  ctx.PropertiesService.getUserProperties = () => store;
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.NF_cursos_ = () => [{ id: 'sample', name: 'Example course' }];
  for (const type of ['Tarea', 'Anuncio', 'Material']) ctx.NF_guardarBase_(store, state, ctx.NF_baseClave_('sample', type), []);
  ctx.NF_publicaciones_ = (_id, type) => type === 'Tarea' ? [{ id: 'new', title: 'New assignment' }] : [];
  ctx.NF_resumen_ = () => ({});
  ctx.NF_calcularVencimiento_ = () => ({ epoch: Date.now() + 48 * 3600000 });
  ctx.NF_materiales_ = () => ({});
  let notices = 0;
  ctx.NF_enviar_ = () => { notices++; };
  ctx.revisarNuevasPublicaciones();
  const reminder = JSON.parse(state[ctx.NF_recordatorioClave_('sample', 'Tarea', 'new')]);
  assert.equal(reminder.enviado24, false);
  assert.equal(reminder.enviado12, false);
  ctx.revisarNuevasPublicaciones();
  assert.equal(notices, 1);
});

test('disabled delivery leaves an event pending and transport limits never silently drop files', () => {
  const { ctx, properties } = setup();
  assert.throws(() => ctx.NF_whatsappEnviar_('example', 'notice', []), /delivery is disabled/);
  properties.WA_BRIDGE_ENABLED = 'true';
  const oversized = { getBytes: () => ({ length: 11 * 1024 * 1024 }) };
  assert.throws(() => ctx.NF_whatsappEnviar_('example', 'notice', [oversized]), /transport limits/);
});
