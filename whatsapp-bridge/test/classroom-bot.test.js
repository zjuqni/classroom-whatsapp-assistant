'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(plan) {
  const requests = [];
  const courses = [{ id: 'math', name: 'Example Mathematics' }, { id: 'french', name: 'Example Language' }];
  const ctx = {
    console, Set, Date,
    NOTIFICADOR_CONFIG: { zonaHoraria: "Etc/UTC", plantilla: { responseLanguage: "English", dateOnlyDueTime: "23:59" } },
    NF_publicadoVisible_: () => "Friday 09/10/2026 at 10:00 (Etc/UTC)",
    NF_TIPOS: ['Tarea', 'Anuncio', 'Material'],
    NF_cursos_: () => courses,
    NF_datosFecha_: epoch => {
      const date = new Date(Number(epoch));
      const iso = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
      return { iso, fecha: `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`, dia: 'Friday', hora: '10:00' };
    },
    NF_localEpoch_: (iso, time) => Date.parse(`${iso}T${time}:00Z`),
    NF_comprobarTiempo_: () => {}, NF_materia_: name => name, NF_periodos_: () => [], NF_periodoHora_: () => '',
    NF_fechaEpoch_: publication => publication.dueEpoch || 0, NF_fecha_: publication => publication.dueDateText || '', NF_comprobarHorario_: () => 'Class is scheduled',
    NF_siguienteClase_: () => null,
    NF_publicaciones_: (course, type) => {
      requests.push({ course, type });
      return [{ id: 'old', creatorUserId: 'teacher', creationTime: '2026-10-01', title: 'Old assignment', description: 'Lesson', alternateLink: 'https://classroom.google.com/old' },
        { id: 'new', creatorUserId: 'teacher', creationTime: '2026-10-09', title: 'New assignment', description: 'Lesson', alternateLink: 'https://classroom.google.com/new' },
        { id: 'other', creatorUserId: 'someone', creationTime: '2026-10-10', title: 'Other teacher', description: '' }];
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../apps-script/ClassroomBot.gs'), 'utf8'), ctx);
  ctx.CB_cached_ = (_key, loader) => loader();
  ctx.CB_teachers_ = course => course === 'french' ? [{ id: 'teacher', name: 'Example Teacher' }] : [{ id: 'another', name: 'Other name' }];
  ctx.CB_vertex_ = (_instructions, value) => { ctx.routeInput = value; return plan; };
  ctx.CB_final_ = (_question, context, posts) => { ctx.finalContext = context; ctx.finalPosts = posts; return 'answer'; };
  return { ctx, requests };
}

function emptyPlan(overrides = {}) {
  return { kind: 'CLASSROOM', courseIds: ['math'], types: ['Tarea'], teacher: '', terms: [], order: 'relevance', limit: 25, ...overrides };
}

test('general questions do not query Classroom publications', () => {
  const s = setup({ kind: 'GENERAL', generalAnswer: 'Photosynthesis...' });
  assert.equal(s.ctx.CB_answer_('What is photosynthesis?'), 'Photosynthesis...');
  assert.equal(s.requests.length, 0);
});

test('teacher lookup filters by author, subject, and creation order', () => {
  const s = setup({ kind: 'CLASSROOM', courseIds: [], types: ['Tarea'], teacher: 'Example Teacher', terms: [], order: 'latest', limit: 1 });
  s.ctx.CB_answer_('What is the latest assignment from Example Teacher?');
  assert.deepEqual(s.requests, [{ course: 'french', type: 'Tarea' }]);
  assert.equal(s.ctx.finalPosts.length, 1);
  assert.equal(s.ctx.finalPosts[0].id, 'new');
  assert.equal(s.ctx.finalPosts[0].author, 'Example Teacher');
  assert.equal(s.ctx.finalContext.totalFound, 2);
});

test('date parser recognizes numeric, written, relative, and month-inferred dates', () => {
  const s = setup({ kind: 'GENERAL', generalAnswer: 'OK' });
  assert.equal(s.ctx.CB_targetDate_('What is due on 14/10/2026?', '2026-10-09').iso, '2026-10-14');
  assert.equal(s.ctx.CB_targetDate_('What is due October 14?', '2026-10-09').iso, '2026-10-14');
  assert.equal(s.ctx.CB_targetDate_('What is due tomorrow?', '2026-10-09').iso, '2026-10-10');
  const due = s.ctx.CB_textDue_('Assignment: submit by October 14.', '2026-10-01T12:00:00Z', '2026-10-09');
  assert.equal(due.iso, '2026-10-14');
  assert.equal(due.inferred, true);
});

test('date search matches explicit deadlines inside descriptions', () => {
  const publications = (_course, type) => type === 'Tarea' ? [
    { id: 'date-match', creatorUserId: 'teacher', creationTime: '2026-10-01T12:00:00Z', title: 'Functions task', description: 'Submit the worksheet by October 14.', alternateLink: 'https://classroom.google.com/date-match' },
    { id: 'other-date', creatorUserId: 'teacher', creationTime: '2026-10-02T12:00:00Z', title: 'Other task', description: 'Submit on October 15.' }
  ] : [];
  const s = setup(emptyPlan({ order: 'due' }));
  s.ctx.NF_publicaciones_ = publications;
  s.ctx.CB_answer_('What is due on October 14, 2026?');
  assert.equal(s.ctx.finalPosts.length, 1);
  assert.equal(s.ctx.finalPosts[0].id, 'date-match');
  assert.equal(s.ctx.finalPosts[0].textDue.iso, '2026-10-14');
});

test('date search matches text deadline even when the official Classroom date differs', () => {
  const s = setup(emptyPlan({ order: 'due' }));
  s.ctx.NF_publicaciones_ = (_course, type) => type === 'Tarea' ? [{
    id: 'conflicting-date', creatorUserId: 'teacher', creationTime: '2026-10-01T12:00:00Z',
    dueEpoch: Date.parse('2026-10-15T23:59:00Z'), dueDateText: 'Thursday 15/10/2026',
    title: 'Functions task', description: 'Submit the worksheet by October 14, 2026.'
  }] : [];
  s.ctx.CB_answer_('What is due on October 14, 2026?');
  assert.equal(s.ctx.finalPosts.length, 1);
  assert.equal(s.ctx.finalPosts[0].id, 'conflicting-date');
  assert.equal(s.ctx.finalPosts[0].dateConflict, true);
  assert.equal(s.ctx.finalPosts[0].effectiveDueDate, '2026-10-15');
});

test('search returns up to 25 results and reports the full match count', () => {
  const s = setup(emptyPlan({ order: 'latest', limit: 25 }));
  s.ctx.NF_publicaciones_ = (_course, type) => type === 'Tarea' ? Array.from({ length: 31 }, (_, index) => ({
    id: `task-${index}`, creatorUserId: 'teacher', creationTime: `2026-10-${String((index % 9) + 1).padStart(2, '0')}T10:00:00Z`, title: `Task ${index}`, description: 'Review the exercises.'
  })) : [];
  s.ctx.CB_answer_('Show all exercise tasks');
  assert.equal(s.ctx.finalPosts.length, 25);
  assert.equal(s.ctx.finalContext.totalFound, 31);
  assert.ok(s.ctx.finalContext.warnings.some(warning => /31 matches/.test(warning)));
});

test('ambiguous assignment solving picks the newest task and identifies it', () => {
  const s = setup(emptyPlan({ kind: 'SOLVE_CLASSROOM', order: 'relevance' }));
  s.ctx.NF_publicaciones_ = (_course, type) => type === 'Tarea' ? [
    { id: 'old-task', creatorUserId: 'teacher', creationTime: '2026-10-01T10:00:00Z', title: 'Older assignment', description: 'Solve the exercises.' },
    { id: 'new-task', creatorUserId: 'teacher', creationTime: '2026-10-09T10:00:00Z', title: 'Latest assignment', description: 'Solve the exercises.' }
  ] : [];
  s.ctx.CB_answer_('Solve my math assignment');
  assert.equal(s.ctx.finalPosts.length, 1);
  assert.equal(s.ctx.finalPosts[0].id, 'new-task');
  assert.ok(s.ctx.finalContext.warnings.some(warning => /Example Mathematics — Latest assignment/.test(warning)));
});

test('Apps Script sanitizes shared history and drops entries older than 24 hours', () => {
  const s = setup({ kind: 'GENERAL', generalAnswer: 'OK' });
  const now = Date.now();
  const history = s.ctx.CB_history_([
    { at: now - 1000, senderName: 'Ana', question: 'Follow up', answer: 'Use the latest assignment.' },
    { at: now - 25 * 60 * 60 * 1000, question: 'Expired', answer: 'Old context' },
    { at: now, senderName: 'Luis', question: 'x'.repeat(3000), answer: 'Answer' }
  ]);
  assert.equal(history.length, 2);
  assert.equal(history[0].senderName, 'Ana');
  assert.equal(history[1].question.length, 2000);
});

test('unknown teachers do not receive fabricated attribution', () => {
  const s = setup({ kind: 'CLASSROOM', courseIds: [], types: ['Tarea'], teacher: 'Missing Teacher', terms: [] });
  assert.match(s.ctx.CB_answer_('latest assignments from Missing Teacher'), /Could not identify/);
  assert.equal(s.requests.length, 0);
});

test('invalid tokens and group IDs are rejected before querying', () => {
  const s = setup({ kind: 'GENERAL', generalAnswer: 'OK' });
  s.ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: key => key === 'WA_BRIDGE_TOKEN' ? 'x'.repeat(32) : 'class@g.us' }) };
  s.ctx.CB_hash_ = value => value;
  s.ctx.CB_json_ = value => value;
  assert.equal(s.ctx.doPost({ postData: { contents: JSON.stringify({ token: 'bad', groupId: 'class@g.us', question: 'Hello' }) } }).ok, false);
  assert.equal(s.ctx.doPost({ postData: { contents: JSON.stringify({ token: 'x'.repeat(32), groupId: 'other@g.us', question: 'Hello' }) } }).ok, false);
  assert.equal(s.requests.length, 0);
});

test('Drive reports permission, size, and unsupported-format failures without fetching external URLs', () => {
  const s = setup({ kind: 'GENERAL', generalAnswer: 'OK' });
  s.ctx.DriveApp = { getFileById: id => {
    if (id === 'private') throw new Error('You do not have permission to access this file');
    if (id === 'large') return { getSize: () => 5 * 1024 * 1024 };
    return { getSize: () => 10, getBlob: () => ({ getContentType: () => 'image/gif', getBytes: () => new Array(10) }), getMimeType: () => 'image/gif' };
  } };
  const warnings = [];
  s.ctx.CB_assignmentFiles_([{ materials: [
    { fileId: 'private', title: 'Private', url: 'https://drive.google.com/private' },
    { fileId: 'large', title: 'Large' }, { fileId: 'unsupported', title: 'Animation' },
    { title: 'External link', url: 'https://example.org/file' }
  ] }], warnings, Date.now() + 10000);
  assert.ok(warnings.some(warning => /did not make it available to the Apps Script account/.test(warning)));
  assert.ok(warnings.some(warning => /exceeds the reading limit/.test(warning)));
  assert.ok(warnings.some(warning => /unsupported format/.test(warning)));
});
