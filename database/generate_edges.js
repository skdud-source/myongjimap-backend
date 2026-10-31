'use strict';

/*
 * edges 테이블을 nodes 좌표로부터 임시로 채우는 스크립트
 *
 * 사용법:  npm run edges:generate            (edges가 비어 있을 때만 실행)
 *          npm run edges:generate -- --force  (기존 edges를 지우고 다시 생성)
 *
 * 주의: 노드 사이의 "가까운 거리"만으로 만든 임시 데이터라서 실제 복도 구조와 다를 수 있다.
 *       실제 간선 데이터가 준비되면 edges를 직접 입력하고 이 스크립트는 쓰지 않는다.
 */

const path = require('path');
const Database = require('better-sqlite3');
const { buildAutoEdges } = require('../lib/graph');

const force = process.argv.includes('--force');
const db = new Database(path.join(__dirname, 'myongjimap.db'));
db.pragma('foreign_keys = ON');

const existing = db.prepare('SELECT COUNT(*) AS count FROM edges').get().count;
if (existing > 0 && !force) {
    console.log(`edges에 이미 ${existing}개의 행이 있어서 아무것도 하지 않았습니다. (다시 만들려면 --force)`);
    process.exit(0);
}

const nodes = db.prepare('SELECT * FROM nodes').all();
const floors = db.prepare('SELECT * FROM floors').all();
const edges = buildAutoEdges(nodes, floors);

const insert = db.prepare(
    'INSERT OR IGNORE INTO edges (start_node_id, end_node_id, weight) VALUES (?, ?, ?)'
);

db.transaction(() => {
    if (force) db.prepare('DELETE FROM edges').run();
    for (const e of edges) {
        // 길은 양방향이므로 양쪽 방향을 모두 저장한다
        insert.run(e.start_node_id, e.end_node_id, e.weight);
        insert.run(e.end_node_id, e.start_node_id, e.weight);
    }
})();

console.log(`간선 ${edges.length}개(양방향 ${edges.length * 2}행)를 저장했습니다.`);
