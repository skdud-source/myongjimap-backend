'use strict';

/*
 * 길찾기 그래프 유틸리티 (DB와 무관한 순수 함수 모음)
 *  - buildAutoEdges : 노드 좌표로 임시 간선을 자동 생성
 *  - buildAdjacency : edges 테이블 행 -> 인접 리스트
 *  - dijkstra / bfs : 최단 거리 경로 / 최소 이동 칸 수 경로
 */

// 엘리베이터로 한 층 이동할 때의 가중치 (SVG 좌표 단위와 같은 척도)
const ELEVATOR_FLOOR_COST = 50;

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function pairKey(a, b) {
    return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function nearest(node, candidates) {
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
        if (c.node_id === node.node_id) continue;
        const d = distance(node, c);
        if (d < bestDist) {
            best = c;
            bestDist = d;
        }
    }
    return best;
}

// Prim 알고리즘: 가까운 노드끼리 이어 모든 노드를 연결하는 최소 신장 트리
function minimumSpanningEdges(nodes) {
    const result = [];
    if (nodes.length < 2) return result;

    const inTree = new Set([nodes[0].node_id]);
    while (inTree.size < nodes.length) {
        let best = null;
        for (const a of nodes) {
            if (!inTree.has(a.node_id)) continue;
            for (const b of nodes) {
                if (inTree.has(b.node_id)) continue;
                const d = distance(a, b);
                if (!best || d < best.weight) {
                    best = { a, b, weight: d };
                }
            }
        }
        inTree.add(best.b.node_id);
        result.push(best);
    }
    return result;
}

/*
 * 임시 간선 자동 생성
 *  1) 같은 층의 복도(CORRIDOR) 노드끼리 가까운 순서로 연결
 *  2) 강의실/입구/엘리베이터는 가장 가까운 복도 노드에 연결
 *  3) 같은 건물의 엘리베이터는 인접한 층끼리 연결
 * 반환값: [{ start_node_id, end_node_id, weight }]  (양방향 중 한 방향만, 저장할 때 양쪽으로 넣는다)
 */
function buildAutoEdges(nodes, floors) {
    const edges = [];
    const seen = new Set();

    function add(a, b, weight) {
        const key = pairKey(a.node_id, b.node_id);
        if (a.node_id === b.node_id || seen.has(key)) return;
        seen.add(key);
        edges.push({
            start_node_id: a.node_id,
            end_node_id: b.node_id,
            weight: Math.round(weight * 10) / 10,
        });
    }

    const byFloor = new Map();
    for (const n of nodes) {
        if (!byFloor.has(n.floor_id)) byFloor.set(n.floor_id, []);
        byFloor.get(n.floor_id).push(n);
    }

    for (const floorNodes of byFloor.values()) {
        const corridors = floorNodes.filter((n) => n.node_type === 'CORRIDOR');

        if (corridors.length === 0) {
            // 복도 노드가 없는 층: 모든 노드를 가까운 순서로 연결
            for (const e of minimumSpanningEdges(floorNodes)) add(e.a, e.b, e.weight);
            continue;
        }

        for (const e of minimumSpanningEdges(corridors)) add(e.a, e.b, e.weight);

        for (const n of floorNodes) {
            if (n.node_type === 'CORRIDOR') continue;
            const c = nearest(n, corridors);
            add(n, c, distance(n, c));
        }
    }

    // 같은 건물의 엘리베이터를 위/아래 층끼리 연결
    const floorOrder = new Map(floors.map((f) => [f.floor_id, f]));
    const elevatorsByBuilding = new Map();
    for (const n of nodes) {
        if (n.node_type !== 'ELEVATOR') continue;
        if (!elevatorsByBuilding.has(n.building_id)) elevatorsByBuilding.set(n.building_id, []);
        elevatorsByBuilding.get(n.building_id).push(n);
    }

    for (const elevators of elevatorsByBuilding.values()) {
        const byLevel = new Map();
        for (const e of elevators) {
            const info = floorOrder.get(e.floor_id);
            if (!info) continue;
            if (!byLevel.has(info.floor)) byLevel.set(info.floor, []);
            byLevel.get(info.floor).push(e);
        }
        const levels = [...byLevel.keys()].sort((a, b) => a - b);
        for (let i = 0; i + 1 < levels.length; i++) {
            const lower = byLevel.get(levels[i]);
            const upper = byLevel.get(levels[i + 1]);
            for (const e of lower) {
                const target = nearest(e, upper) || upper[0];
                // nearest()는 같은 층 좌표 거리 기준이므로 충분히 가까운 짝을 고른다
                add(e, target, ELEVATOR_FLOOR_COST);
            }
        }
    }

    return edges;
}

// edges 테이블 행 -> 인접 리스트 (Map<node_id, [{to, weight}]>)
function buildAdjacency(edgeRows) {
    const adj = new Map();
    for (const e of edgeRows) {
        if (!adj.has(e.start_node_id)) adj.set(e.start_node_id, []);
        adj.get(e.start_node_id).push({ to: e.end_node_id, weight: e.weight });
    }
    return adj;
}

function restorePath(prev, src, dst) {
    const path = [];
    let cur = dst;
    while (cur !== undefined) {
        path.push(cur);
        if (cur === src) break;
        cur = prev.get(cur);
    }
    path.reverse();
    return path[0] === src ? path : null;
}

function pathLength(adj, path) {
    let total = 0;
    for (let i = 0; i + 1 < path.length; i++) {
        const next = (adj.get(path[i]) || []).find((e) => e.to === path[i + 1]);
        total += next ? next.weight : 0;
    }
    return total;
}

// 다익스트라: 가중치(거리) 합이 가장 작은 경로. 노드가 수백 개 수준이라 단순 선형 탐색을 사용한다.
function dijkstra(adj, src, dst) {
    const dist = new Map([[src, 0]]);
    const prev = new Map();
    const visited = new Set();

    while (true) {
        let current = null;
        let currentDist = Infinity;
        for (const [id, d] of dist) {
            if (!visited.has(id) && d < currentDist) {
                current = id;
                currentDist = d;
            }
        }
        if (current === null) return null; // 더 이상 갈 수 있는 노드가 없음
        if (current === dst) break;
        visited.add(current);

        for (const { to, weight } of adj.get(current) || []) {
            const nd = currentDist + weight;
            if (nd < (dist.has(to) ? dist.get(to) : Infinity)) {
                dist.set(to, nd);
                prev.set(to, current);
            }
        }
    }

    const path = restorePath(prev, src, dst);
    return path ? { path, distance: dist.get(dst) } : null;
}

// BFS: 거치는 노드 수가 가장 적은 경로 (가중치는 무시)
function bfs(adj, src, dst) {
    const prev = new Map();
    const visited = new Set([src]);
    const queue = [src];

    for (let head = 0; head < queue.length; head++) {
        const current = queue[head];
        if (current === dst) break;
        for (const { to } of adj.get(current) || []) {
            if (visited.has(to)) continue;
            visited.add(to);
            prev.set(to, current);
            queue.push(to);
        }
    }

    if (!visited.has(dst)) return null;
    const path = restorePath(prev, src, dst);
    return path ? { path, distance: pathLength(adj, path) } : null;
}

module.exports = {
    ELEVATOR_FLOOR_COST,
    buildAutoEdges,
    buildAdjacency,
    dijkstra,
    bfs,
};
