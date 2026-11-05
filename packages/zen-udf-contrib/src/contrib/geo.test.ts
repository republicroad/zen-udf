import { describe, expect, test } from "vitest";

import { geoDistance, geoFence } from "./geo.ts";

/** 黄金值：北京(39.9042, 116.4074) ↔ 上海(31.2304, 121.4737) 大圆距离约 1068km */
const BJ = { lat: 39.9042, lon: 116.4074 };
const SH = { lat: 31.2304, lon: 121.4737 };

describe("geo_distance", () => {
  test("北京↔上海 大圆距离落在公开黄金区间（1060–1075km）", () => {
    const r = geoDistance({ lat1: BJ.lat, lon1: BJ.lon, lat2: SH.lat, lon2: SH.lon }) as {
      distance: number;
      unit: string;
    };
    expect(r.unit).toBe("km");
    expect(r.distance).toBeGreaterThan(1060);
    expect(r.distance).toBeLessThan(1075);
  });

  test("m 单位换算与对称性", () => {
    const km = geoDistance({ lat1: BJ.lat, lon1: BJ.lon, lat2: SH.lat, lon2: SH.lon }) as { distance: number };
    const m = geoDistance({ lat1: BJ.lat, lon1: BJ.lon, lat2: SH.lat, lon2: SH.lon, unit: "m" }) as {
      distance: number;
    };
    expect(m.distance).toBeCloseTo(km.distance * 1000, 6);
    const reverse = geoDistance({ lat1: SH.lat, lon1: SH.lon, lat2: BJ.lat, lon2: BJ.lon }) as { distance: number };
    expect(reverse.distance).toBeCloseTo(km.distance, 6);
  });

  test("非法坐标结构化报错", () => {
    expect((geoDistance({ lat1: 95, lon1: 0, lat2: 1, lon2: 1 }) as { error: string }).error).toContain("coordinates");
    expect((geoDistance({ lat1: NaN, lon1: 0, lat2: 1, lon2: 1 }) as { error: string }).error).toContain("coordinates");
  });
});

describe("geo_fence", () => {
  const point = { lat: 39.9, lon: 116.4 };

  test("圆形围栏：圆内/圆外", () => {
    const inside = geoFence({ point, circle: { lat: 39.9, lon: 116.4, radius: 5 } }) as { inside: boolean };
    expect(inside.inside).toBe(true);
    const far = geoFence({ point, circle: { lat: 31.23, lon: 121.47, radius: 5 } }) as { inside: boolean };
    expect(far.inside).toBe(false);
  });

  test("多边形围栏：内部点 inside、外部点 outside", () => {
    // 顶点按纬经度构造的矩形：lat 30–32, lon 120–122
    const polygon = [
      [31, 120],
      [31, 122],
      [32, 122],
      [32, 120],
    ];
    const inside = geoFence({ point: { lat: 31.5, lon: 121 }, polygon }) as { inside: boolean };
    expect(inside.inside).toBe(true);
    const outside = geoFence({ point: { lat: 33, lon: 121 }, polygon }) as { inside: boolean };
    expect(outside.inside).toBe(false);
  });

  test("circle 与 polygon 均缺失报错；非法多边形点数报错", () => {
    expect((geoFence({ point }) as { error: string }).error).toContain("circle or polygon");
    expect(
      (
        geoFence({
          point,
          polygon: [
            [31, 120],
            [31, 122],
          ],
        }) as { error: string }
      ).error,
    ).toContain("polygon requires");
  });
});
