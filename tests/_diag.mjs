
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
const { initDb, resetDemoDb } = await import('../src/lib/db.ts');
const repo = await import('../src/lib/repo.ts');
resetDemoDb(); await initDb(); await repo.seedIfEmpty();
const lists = await repo.fetchLists();
const work = lists.find(l => l.name === '工作');
const t = await repo.createTask({ listId: work.id, title: 'X', myDay: true });
console.log('创建后 myday 查询:', (await repo.fetchTasks({view:'myday'})).map(x=>x.title));
await repo.updateTask(t.id, { done: true });
const rows = await repo.fetchTasks({ view: 'myday', includeDone: true });
console.log('完成后 myday(含done) 查询:', rows.map(x=>({t:x.title, done:x.done, myDay:x.myDay})));
const rows2 = await repo.fetchTasks({ view: 'myday' });
console.log('完成后 myday(不含done) 查询:', rows2.map(x=>x.title));
