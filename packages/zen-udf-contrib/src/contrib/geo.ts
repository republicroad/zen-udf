import { globalUdfRegistry, pack, tool } from "@republicroad/zen-udf";

import { Type } from "@sinclair/typebox";

// geo 域(geo_distance / geo_fence 函数)：Haversine 大圆距离与围栏判定。
// 纯数学、datum 无关——调用方必须保证同 datum 坐标（GCJ-02/WGS-84 混用会差 100–700m）。
//
// ADR-011 迁移：理想态 tool()/pack()。geoDistance/geoFence 裸函数保留导出（测试签名不变）。



const EARTH_RADIUS_KM = 6371.0088; // IUGG 平均半径
const MAX_POLYGON_POINTS = 256;

const toRad = (deg: number) => (deg * Math.PI) / 180;

interface Coordinate {
  lat: number;
  lon: number;
}

const asCoordinate = (value: unknown): Coordinate | null => {
  const record = value as Coordinate | undefined;
  if (!record || typeof record.lat !== "number" || typeof record.lon !== "number") return null;
  if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return null;
  if (record.lat < -90 || record.lat > 90 || record.lon < -180 || record.lon > 180) return null;
  return { lat: record.lat, lon: record.lon };
};

const haversineKm = (p1: Coordinate, p2: Coordinate): number => {
  const dLat = toRad(p2.lat - p1.lat);
  const dLon = toRad(p2.lon - p1.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/** 射线法（even-odd）：小范围平面近似，跨 ±180° 经线不适用 */
const pointInPolygon = (point: Coordinate, polygon: Coordinate[]): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = [polygon[i].lon, polygon[i].lat];
    const [xj, yj] = [polygon[j].lon, polygon[j].lat];
    const intersects = yi > point.lat !== yj > point.lat && point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

const geoErrorResult = (error: string) => ({ distance: null, inside: null, error });

/** 裸函数形态（kwargs 签名）：测试与纯函数消费方沿用 */
export const geoDistance = (kwargs: Record<string, unknown>) => {
  const p1 = asCoordinate({ lat: kwargs?.lat1, lon: kwargs?.lon1 });
  const p2 = asCoordinate({ lat: kwargs?.lat2, lon: kwargs?.lon2 });
  if (!p1 || !p2) {
    return geoErrorResult("coordinates must be finite numbers within lat [-90,90] and lon [-180,180]");
  }
  const unit = kwargs?.unit === "m" ? "m" : "km";
  const distanceKm = haversineKm(p1, p2);
  return { distance: unit === "m" ? distanceKm * 1000 : distanceKm, unit };
};

export const geoFence = (kwargs: Record<string, unknown>) => {
  const point = asCoordinate(kwargs?.point);
  if (!point) {
    return geoErrorResult("point must be { lat, lon } with finite valid coordinates");
  }
  const circle = kwargs?.circle as { lat?: unknown; lon?: unknown; radius?: unknown } | undefined;
  const polygonRaw = kwargs?.polygon as unknown[] | undefined;

  if (circle) {
    const center = asCoordinate(circle);
    const radius = Number(circle?.radius);
    if (!center || !Number.isFinite(radius) || radius <= 0) {
      return geoErrorResult("circle must be { lat, lon, radius(km) } with a positive radius");
    }
    const distance = haversineKm(point, center);
    return { inside: distance <= radius, distance };
  }
  if (Array.isArray(polygonRaw)) {
    if (polygonRaw.length < 3 || polygonRaw.length > MAX_POLYGON_POINTS) {
      return geoErrorResult(`polygon requires 3–${MAX_POLYGON_POINTS} points`);
    }
    const polygon = polygonRaw.map((p) =>
      Array.isArray(p) ? asCoordinate({ lat: p[0], lon: p[1] }) : asCoordinate(p),
    );
    if (polygon.some((p) => !p)) {
      return geoErrorResult("polygon contains an invalid coordinate");
    }
    const inside = pointInPolygon(point, polygon as Coordinate[]);
    const nearest = Math.min(...(polygon as Coordinate[]).map((p) => haversineKm(point, p)));
    return { inside, distance: nearest };
  }
  return geoErrorResult("provide circle or polygon");
};

export const geoDistanceTool = tool({
  namespace: "geo",
  name: "distance",
  title: "geo_distance",
  description:
    "计算两经纬度点的 Haversine 大圆距离（球面近似，误差约 0.5%，决策场景够用）。" +
    "unit 支持 km/m；坐标需同 datum（GCJ-02/WGS-84 混用会差 100–700m）。非法坐标返回结构化错误。",
  semantics: "query",
  input: Type.Object({
    lat1: Type.Number({ title: "Lat1", description: "起点纬度 [-90, 90]" }),
    lon1: Type.Number({ title: "Lon1", description: "起点经度 [-180, 180]" }),
    lat2: Type.Number({ title: "Lat2", description: "终点纬度" }),
    lon2: Type.Number({ title: "Lon2", description: "终点经度" }),
    unit: Type.Optional(Type.String({ title: "Unit", description: "距离单位 km/m，默认 km", default: "km" })),
  }),
  output: Type.Object({
    distance: Type.Union([Type.Number(), Type.Null()], { title: "距离" }),
    unit: Type.Optional(Type.String({ title: "Unit" })),
    error: Type.Optional(Type.String({ title: "Error" })),
  }),
  run: (input) => geoDistance(input as unknown as Record<string, unknown>),
});

export const geoFenceTool = tool({
  namespace: "geo",
  name: "fence",
  title: "geo_fence",
  description:
    "围栏判定：圆形（circle: {lat, lon, radius km}）或多边形（polygon: [[lat,lon],...]，射线法）。" +
    "返回 { inside, distance }——distance 为点到圆心/多边形的最近大圆距离(km)。",
  semantics: "query",
  input: Type.Object({
    point: Type.Object(
      { lat: Type.Number({ description: "纬度" }), lon: Type.Number({ description: "经度" }) },
      { title: "Point", description: "{ lat, lon }" },
    ),
    circle: Type.Optional(
      Type.Object(
        {
          lat: Type.Number({ description: "圆心纬度" }),
          lon: Type.Number({ description: "圆心经度" }),
          radius: Type.Number({ description: "半径(km)" }),
        },
        { title: "Circle", description: "{ lat, lon, radius(km)" },
      ),
    ),
    polygon: Type.Optional(
      Type.Array(Type.Union([Type.Array(Type.Number()), Type.Object({ lat: Type.Number(), lon: Type.Number() })]), {
        title: "Polygon",
        description: "[[lat,lon],...] 顶点序列，自动闭合",
      }),
    ),
  }),
  output: Type.Object({
    inside: Type.Union([Type.Boolean(), Type.Null()]),
    distance: Type.Union([Type.Number(), Type.Null()]),
    error: Type.Optional(Type.String()),
  }),
  run: (input) => geoFence(input as unknown as Record<string, unknown>),
});

export default pack({ id: "geo", tools: [geoDistanceTool, geoFenceTool] });

// 全局注册（import 副作用，接替 defineContrib 的模块级注册）
globalUdfRegistry.register(pack({ id: "geo", tools: [geoDistanceTool, geoFenceTool] }));
