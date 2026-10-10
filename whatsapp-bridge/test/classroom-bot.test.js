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
    NOTIFICADOR_CONFIG: { zonaHoraria: "Etc/UTC", plantilla: { responseLanguage: "English" } },
    NF_publicadoVisible_: () => "Friday 09/10/2026 at 10:00 (Etc/UTC)",
    NF_TIPOS: ['Tarea', 'Anuncio', 'Material'],
    NF_cursos_: () => courses,
    NF_datosFecha_: () => ({ iso: '2026-10-09', dia: 'Friday', hora: '10:00' }),
    NF_comprobarTiempo_: () => {}, NF_materia_: name => name, NF_periodos_: () => [], NF_periodoHora_: () => '',
    NF_fechaEpoch_: () => 1, NF_fecha_: () => 'Friday 09/10/2026', NF_comprobarHorario_: () => 'Class is scheduled',
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
