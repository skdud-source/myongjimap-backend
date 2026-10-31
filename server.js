
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const { buildAdjacency, dijkstra, bfs } = require('./lib/graph');

const app = express();
// 배포 서버(Render 등)는 PORT 환경변수로 포트를 알려 준다. 없으면 로컬 개발용 3000번을 쓴다.
const PORT = process.env.PORT || 3000;

// CORS: 프론트엔드(Vite 개발 서버)에서 이 서버를 호출할 수 있도록 허용
// 기본값은 localhost / 127.0.0.1 의 모든 포트(5173, 5174 등)이고,
// 환경변수 CORS_ORIGIN 에 쉼표로 주소를 적으면 그 주소만 허용한다.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true); // curl 등 브라우저가 아닌 요청
        const ok = allowedOrigins.length > 0
            ? allowedOrigins.includes(origin)
            : localOrigin.test(origin);
        callback(null, ok);
    }
}));

// JSON 데이터 받기
app.use(express.json());

// 쓰기 보호: 인터넷에 공개된 서버에서는 아무나 노드를 등록/삭제하면 안 된다.
//  - 로컬 개발(NODE_ENV 가 production 이 아니고 ADMIN_TOKEN 도 없음): 기존처럼 모두 허용
//  - 운영(NODE_ENV=production): 요청 헤더 x-admin-token 이 환경변수 ADMIN_TOKEN 과 같을 때만 허용
//    (ADMIN_TOKEN 을 설정하지 않으면 등록/삭제는 전부 막힌다. 조회(GET)는 항상 허용)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
app.use('/api/nodes', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'OPTIONS') return next();
    if (process.env.NODE_ENV !== 'production' && !ADMIN_TOKEN) return next();
    if (ADMIN_TOKEN && req.get('x-admin-token') === ADMIN_TOKEN) return next();
    return res.status(403).json({ error: '노드 등록/삭제는 관리자만 할 수 있습니다.' });
});

// SQLite 데이터베이스 연결
const dbPath = path.join(__dirname, 'database', 'myongjimap.db');
const db = new Database(dbPath);
console.log('연결된 DB 파일:', dbPath);

// 외래 키 검사 활성화
db.pragma('foreign_keys = ON');

// 좌표 등록 도구 화면 제공
app.use(express.static(path.join(__dirname, 'coordinate-tool')));

// 서버 상태 확인
app.get('/api/health', (req, res) => {
    res.json({ message: '서버가 정상적으로 실행 중입니다.' });
});

// 등록된 노드 확인
app.get('/api/nodes', (req, res) => {
    const nodes = db.prepare('SELECT * FROM nodes').all();
    res.json(nodes);
});


app.delete('/api/nodes/:id', (req, res) => {
    try {
        const nodeId = Number(req.params.id);

        if (!Number.isInteger(nodeId) || nodeId <= 0) {
            return res.status(400).json({
                error: '올바르지 않은 노드 ID입니다.'
            });
        }

        const result = db.prepare(
            'DELETE FROM nodes WHERE node_id = ?'
        ).run(nodeId);

        if (result.changes === 0) {
            return res.status(404).json({
                error: '삭제할 노드를 찾을 수 없습니다.'
            });
        }

        res.json({
            message: '노드가 삭제되었습니다.'
        });
    } catch (error) {
        console.error('노드 삭제 오류:', error.message);
        res.status(500).json({
            error: '노드 삭제에 실패했습니다.'
        });
    }
});


// 서버 실행
app.listen(PORT, () => {
    console.log(`서버 실행 주소: http://localhost:${PORT}`);
});


/* 노드 좌표를 데이터베이스에 저장 */
app.post('/api/nodes', (req, res) => {
    try {
        const {
            building_id,
            floor_id,
            node_name,
            node_type,
            x,
            y
        } = req.body;

        // 필수 데이터 확인
        if (
            !building_id ||
            !floor_id ||
            !node_type ||
            x === undefined ||
            y === undefined
        ) {
            return res.status(400).json({
                error: '건물, 층, 노드 유형, x, y 좌표가 필요합니다.'
            });
        }

        // 허용된 노드 유형 확인
        const allowedTypes = [
            'ENTRANCE',
            'CORRIDOR',
            'CLASSROOM',
            'ELEVATOR'
        ];

        if (!allowedTypes.includes(node_type)) {
            return res.status(400).json({
                error: '올바르지 않은 노드 유형입니다.'
            });
        }

        // SQLite에 노드 저장
        const stmt = db.prepare(`
            INSERT INTO nodes (
                building_id,
                floor_id,
                node_name,
                node_type,
                x,
                y
            )
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            building_id,
            floor_id,
            node_name || null,
            node_type,
            Number(x),
            Number(y)
        );

        res.status(201).json({
            message: '노드 좌표가 저장되었습니다.',
            node_id: result.lastInsertRowid
        });

    } catch (error) {
        console.error('노드 저장 오류:', error.message);

        res.status(500).json({
            error: '노드 저장에 실패했습니다. 건물과 층 정보도 확인해 주세요.'
        });
    }
});


/* ===== 아래부터는 프론트엔드 연동을 위해 새로 추가한 API (기존 API는 변경하지 않음) ===== */

// [추가] 건물 목록
app.get('/api/buildings', (req, res) => {
    try {
        const buildings = db.prepare('SELECT * FROM buildings').all();
        res.json(buildings);
    } catch (error) {
        console.error('건물 조회 오류:', error.message);
        res.status(500).json({ error: '건물 정보를 불러오지 못했습니다.' });
    }
});

// [추가] 층 목록 (건물별, 층 번호 순). 예: /api/floors?building_id=Y09
app.get('/api/floors', (req, res) => {
    try {
        const { building_id } = req.query;
        const floors = building_id
            ? db.prepare('SELECT * FROM floors WHERE building_id = ? ORDER BY floor').all(building_id)
            : db.prepare('SELECT * FROM floors ORDER BY building_id, floor').all();
        res.json(floors);
    } catch (error) {
        console.error('층 조회 오류:', error.message);
        res.status(500).json({ error: '층 정보를 불러오지 못했습니다.' });
    }
});

// [추가] 간선 목록
app.get('/api/edges', (req, res) => {
    try {
        const edges = db.prepare('SELECT * FROM edges').all();
        res.json(edges);
    } catch (error) {
        console.error('간선 조회 오류:', error.message);
        res.status(500).json({ error: '간선 정보를 불러오지 못했습니다.' });
    }
});

// [추가] 경로 탐색. 예: /api/route?from=100&to=111&algorithm=dijkstra
//   algorithm: dijkstra(기본, 거리 최단) 또는 bfs(거치는 노드 수 최소)
app.get('/api/route', (req, res) => {
    try {
        const from = Number(req.query.from);
        const to = Number(req.query.to);
        const algorithm = String(req.query.algorithm || 'dijkstra').toLowerCase();

        if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0) {
            return res.status(400).json({ error: '출발 노드(from)와 도착 노드(to)의 ID가 필요합니다.' });
        }
        if (algorithm !== 'dijkstra' && algorithm !== 'bfs') {
            return res.status(400).json({ error: 'algorithm은 dijkstra 또는 bfs만 사용할 수 있습니다.' });
        }

        const nodeById = new Map(
            db.prepare('SELECT * FROM nodes').all().map((node) => [node.node_id, node])
        );
        if (!nodeById.has(from) || !nodeById.has(to)) {
            return res.status(404).json({ error: '출발 또는 도착 노드를 찾을 수 없습니다.' });
        }

        if (from === to) {
            return res.json({ algorithm, total_distance: 0, nodes: [nodeById.get(from)] });
        }

        const edgeRows = db.prepare('SELECT start_node_id, end_node_id, weight FROM edges').all();
        if (edgeRows.length === 0) {
            return res.status(404).json({
                error: '등록된 간선 데이터가 없어 경로를 찾을 수 없습니다. (npm run edges:generate)'
            });
        }

        const adjacency = buildAdjacency(edgeRows);
        const result = algorithm === 'bfs'
            ? bfs(adjacency, from, to)
            : dijkstra(adjacency, from, to);

        if (!result) {
            return res.status(404).json({ error: '두 위치를 잇는 경로가 없습니다.' });
        }

        res.json({
            algorithm,
            total_distance: Math.round(result.distance * 10) / 10,
            nodes: result.path.map((id) => nodeById.get(id))
        });
    } catch (error) {
        console.error('경로 탐색 오류:', error.message);
        res.status(500).json({ error: '경로 탐색에 실패했습니다.' });
    }
});
