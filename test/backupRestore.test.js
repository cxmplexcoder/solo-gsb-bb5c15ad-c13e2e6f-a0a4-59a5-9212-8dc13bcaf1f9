'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');
const { validateBackup } = require('../server/familyGraph');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-backup-'));
  return path.join(dir, 'family.json');
}

/** 一份合法备份：祖父母 → 父，父 + 母 → 子 */
function validBackup() {
  return {
    members: [
      { id: 'gp', name: '祖父' },
      { id: 'gm', name: '祖母' },
      { id: 'fa', name: '父' },
      { id: 'mo', name: '母' },
      { id: 'kid', name: '子' },
    ],
    edges: [
      { parentId: 'gp', childId: 'fa' },
      { parentId: 'gm', childId: 'fa' },
      { parentId: 'fa', childId: 'kid' },
      { parentId: 'mo', childId: 'kid' },
    ],
  };
}

/* ---------------- validateBackup 纯函数：整份严格校验、逐项报错 ---------------- */

test('合法备份通过校验，返回规范化的成员与关系', () => {
  const r = validateBackup(validBackup());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.members.length, 5);
  assert.equal(r.edges.length, 4);
  // 保持文件顺序
  assert.deepEqual(r.members.map((m) => m.id), ['gp', 'gm', 'fa', 'mo', 'kid']);
});

test('结构非法：非对象、缺少数组、条目非对象都逐项报错', () => {
  assert.equal(validateBackup(null).valid, false);
  assert.equal(validateBackup([1, 2]).valid, false);
  assert.match(validateBackup({}).errors.join('\n'), /members/);
  assert.match(validateBackup({}).errors.join('\n'), /edges/);

  const r = validateBackup({ members: ['x', { id: 'a' }], edges: ['y'] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('成员 #1')));
  assert.ok(r.errors.some((e) => e.includes('成员 #2'))); // 缺 name
  assert.ok(r.errors.some((e) => e.includes('关系 #1')));
});

test('重复成员 ID：逐项报错且不静默丢弃', () => {
  const backup = validBackup();
  backup.members.push({ id: 'fa', name: '另一个父' }); // 与 #3 重复
  const r = validateBackup(backup);
  assert.equal(r.valid, false);
  const dupErrors = r.errors.filter((e) => e.includes('重复'));
  assert.equal(dupErrors.length, 1);
  assert.ok(dupErrors[0].includes('成员 #6'));
  assert.ok(dupErrors[0].includes('成员 #3'));
  // 两份条目都没有被静默吞掉：错误中可见，且合法成员仍保留
  assert.equal(r.members.length, 5);
});

test('缺失端点：父母/子女不在成员列表中逐项报错', () => {
  const backup = validBackup();
  backup.edges.push({ parentId: 'ghost', childId: 'kid' });
  backup.edges.push({ parentId: 'fa', childId: 'nobody' });
  const r = validateBackup(backup);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('关系 #5') && e.includes('父母端点缺失')));
  assert.ok(r.errors.some((e) => e.includes('关系 #6') && e.includes('子女端点缺失')));
});

test('自指、重复关系、超过两位父母、祖先环路逐项报错', () => {
  // 自指
  const self = validBackup();
  self.edges.push({ parentId: 'fa', childId: 'fa' });
  const rSelf = validateBackup(self);
  assert.equal(rSelf.valid, false);
  assert.ok(rSelf.errors.some((e) => e.includes('自指')));

  // 重复关系（第二处被标记，并指出首次位置）
  const dup = validBackup();
  dup.edges.push({ parentId: 'fa', childId: 'kid' });
  const rDup = validateBackup(dup);
  assert.equal(rDup.valid, false);
  assert.ok(rDup.errors.some((e) => e.includes('关系 #5') && e.includes('重复关系') && e.includes('关系 #3')));

  // 超过两位父母
  const extra = validBackup();
  extra.members.push({ id: 'x', name: '第三人' });
  extra.edges.push({ parentId: 'x', childId: 'kid' }); // kid 将有 3 位父母
  const rExtra = validateBackup(extra);
  assert.equal(rExtra.valid, false);
  assert.ok(rExtra.errors.some((e) => e.includes('「子」') && e.includes('3 位父母')));

  // 祖先环路：子 → 祖父 使祖父成为自己的祖先
  const cyc = validBackup();
  cyc.edges.push({ parentId: 'kid', childId: 'gp' });
  const rCyc = validateBackup(cyc);
  assert.equal(rCyc.valid, false);
  assert.ok(rCyc.errors.some((e) => e.includes('祖先环路')));
});

test('成员超过 30 人上限与空姓名 / 超长姓名被拒绝', () => {
  const many = { members: [], edges: [] };
  for (let i = 0; i < 31; i++) many.members.push({ id: `m${i}`, name: `成员${i}` });
  const rMany = validateBackup(many);
  assert.equal(rMany.valid, false);
  assert.ok(rMany.errors.some((e) => e.includes('31') && e.includes('30')));

  const badName = validateBackup({
    members: [{ id: 'a', name: '  ' }, { id: 'b', name: 'x'.repeat(51) }],
    edges: [],
  });
  assert.equal(badName.valid, false);
  assert.equal(badName.errors.length, 2);
});

/* ---------------- 预览：只读、不推进版本 ---------------- */

test('备份预览：返回数量与指纹，不修改数据也不推进版本', () => {
  const store = createStore(tmpFile());
  store.addMember('现有成员');
  const v = store.getVersion();

  const preview = store.previewBackup(validBackup());
  assert.equal(preview.valid, true);
  assert.equal(preview.memberCount, 5);
  assert.equal(preview.edgeCount, 4);
  assert.equal(typeof preview.fingerprint, 'string');
  assert.ok(preview.fingerprint.length > 0);

  // 非法备份：valid=false、逐项 errors、无指纹
  const bad = store.previewBackup({ members: [{ id: 'a', name: 'A' }], edges: [{ parentId: 'a', childId: 'a' }] });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length > 0);
  assert.equal(bad.fingerprint, null);

  // 预览完全只读
  assert.equal(store.getVersion(), v);
  assert.equal(store.list().members.length, 1);
  assert.equal(store.list().edges.length, 0);
  assert.equal(store.list().undo.label.includes('现有成员'), true);
});

/* ---------------- 恢复提交：版本 + 指纹 + 重验，原子替换并纳入撤销 ---------------- */

test('恢复成功：原子替换家谱、版本 +1、一次落盘并纳入最近一次撤销', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('旧甲').member;
  const b = store.addMember('旧乙').member;
  store.addEdge(a.id, b.id);
  const v = store.getVersion();

  const backup = validBackup();
  const preview = store.previewBackup(backup);
  const result = store.restoreBackup(backup, v, preview.fingerprint);
  assert.equal(result.error, null);

  const data = store.list();
  assert.equal(data.members.length, 5);
  assert.equal(data.edges.length, 4);
  assert.equal(data.version, v + 1); // 版本只加一
  assert.ok(!data.members.some((m) => m.id === a.id)); // 旧家谱被整体替换
  assert.match(data.undo.label, /恢复备份（5 名成员、4 条关系）/);

  // 重启后状态一致（原子落盘）
  const reloaded = createStore(file).list();
  assert.equal(reloaded.members.length, 5);
  assert.equal(reloaded.edges.length, 4);
  assert.equal(reloaded.version, v + 1);
  assert.match(reloaded.undo.label, /恢复备份/);
});

test('恢复后可撤销：恢复前的完整家谱（ID/姓名/关系）整体回来', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('旧甲').member;
  const b = store.addMember('旧乙').member;
  store.addEdge(a.id, b.id);
  const before = store.list();
  const v = store.getVersion();

  const backup = validBackup();
  const preview = store.previewBackup(backup);
  assert.equal(store.restoreBackup(backup, v, preview.fingerprint).error, null);
  assert.equal(store.list().members.length, 5);

  assert.equal(store.undoLast(store.getVersion()).error, null);
  const restored = store.list();
  assert.deepEqual(
    restored.members.map((m) => [m.id, m.name]).sort(),
    before.members.map((m) => [m.id, m.name]).sort(),
  );
  assert.deepEqual(restored.edges, [{ parentId: a.id, childId: b.id }]);
  assert.equal(restored.version, v + 2); // 恢复 +1、撤销再 +1
  assert.equal(restored.undo, null); // 快照已清空，不能重复撤销
});

test('恢复提交：版本过期（预览后家谱被修改）被 409 拒绝且零写入', () => {
  const store = createStore(tmpFile());
  store.addMember('旧成员');
  const v = store.getVersion();

  const backup = validBackup();
  const preview = store.previewBackup(backup);

  // 预览之后其他操作改动了家谱
  store.addMember('新成员');

  const result = store.restoreBackup(backup, v, preview.fingerprint);
  assert.equal(result.status, 409);
  assert.match(result.error, /重新预览/);
  assert.equal(result.currentVersion, store.getVersion());
  // 数据保持不变：还是旧家谱 + 新成员
  assert.equal(store.list().members.length, 2);
  assert.equal(store.list().edges.length, 0);
});

test('恢复提交：文件变更（指纹不符）被 409 拒绝且零写入', () => {
  const store = createStore(tmpFile());
  store.addMember('旧成员');
  const v = store.getVersion();

  const backup = validBackup();
  const preview = store.previewBackup(backup);

  // 预览后文件被改动：成员更名 / 内容不同
  const changed = validBackup();
  changed.members[0] = { id: 'gp', name: '曾祖父' };
  const result = store.restoreBackup(changed, v, preview.fingerprint);
  assert.equal(result.status, 409);
  assert.match(result.error, /已变更/);
  assert.equal(store.list().members.length, 1);
  assert.equal(store.getVersion(), v);

  // 指纹缺失 / 伪造同样拒绝
  const missing = store.restoreBackup(backup, v, undefined);
  assert.equal(missing.status, 400);
  assert.match(missing.error, /指纹/);
  const forged = store.restoreBackup(backup, v, 'deadbeef');
  assert.equal(forged.status, 409);
  assert.equal(store.getVersion(), v);
});

test('恢复提交：服务端重验发现非法文件，逐项报错且零写入、版本与快照不变', () => {
  const store = createStore(tmpFile());
  store.addMember('旧成员');
  const v = store.getVersion();

  // 未经预览直接提交非法文件（重复 ID + 缺失端点 + 自指）
  const bad = {
    members: [
      { id: 'a', name: '甲' },
      { id: 'a', name: '甲二号' },
    ],
    edges: [
      { parentId: 'a', childId: 'ghost' },
      { parentId: 'a', childId: 'a' },
    ],
  };
  const result = store.restoreBackup(bad, v, 'whatever');
  assert.equal(result.status, 400);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.some((e) => e.includes('重复')));
  assert.ok(result.errors.some((e) => e.includes('端点缺失')));
  assert.ok(result.errors.some((e) => e.includes('自指')));

  // 零写入：版本不变、数据不变、撤销快照仍指向「添加成员」
  assert.equal(store.getVersion(), v);
  assert.equal(store.list().members.length, 1);
  assert.match(store.list().undo.label, /添加成员「旧成员」/);
});

test('恢复提交：缺少版本号被 400 拒绝', () => {
  const store = createStore(tmpFile());
  const backup = validBackup();
  const preview = store.previewBackup(backup);
  const result = store.restoreBackup(backup, undefined, preview.fingerprint);
  assert.equal(result.status, 400);
  assert.match(result.error, /版本号/);
  assert.equal(store.getVersion(), 0);
});

test('恢复空家谱备份合法：清空全部成员与关系', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('甲').member;
  const b = store.addMember('乙').member;
  store.addEdge(a.id, b.id);
  const v = store.getVersion();

  const empty = { members: [], edges: [] };
  const preview = store.previewBackup(empty);
  assert.equal(preview.valid, true);
  assert.equal(store.restoreBackup(empty, v, preview.fingerprint).error, null);
  assert.equal(store.list().members.length, 0);
  assert.equal(store.list().edges.length, 0);
  assert.equal(store.getVersion(), v + 1);
});

test('指纹对内容顺序敏感：同一份内容指纹稳定，顺序变化指纹不同', () => {
  const store = createStore(tmpFile());
  const backup = validBackup();
  const f1 = store.previewBackup(backup).fingerprint;
  const f2 = store.previewBackup(validBackup()).fingerprint;
  assert.equal(f1, f2); // 同样内容 → 指纹稳定

  const reordered = validBackup();
  reordered.members.reverse();
  const f3 = store.previewBackup(reordered).fingerprint;
  assert.notEqual(f1, f3); // 顺序变化 → 指纹不同
});
