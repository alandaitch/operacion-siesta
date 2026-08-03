// OPERATION NAPTIME — module ROOM — the architectural shell.
// OWNER: ROOM. Floor, walls, the ceiling slab, the downstand beam, the doorway and the hallway.
//
// THE CEILING IS THE HERO. The reference photograph is shot from 2.3 m up, so the raw board-formed
// slab is the largest object in the frame. It gets three layers of relief, in descending scale:
//   · a 9 mm structural sag across the whole 6.8 x 8.0 m bay, which the low winter sun reads as a
//     slow tonal sweep rather than as a shape;
//   · a 300 mm board rhythm, modelled as real geometry — each formwork board bows and each joint
//     hangs 1.6 mm proud where the slurry leaked — so the seams cast their own micro-shadow and do
//     not depend on the normal map alone at grazing incidence;
//   · per-vertex occlusion into the wall junctions and hard into the downstand beam's reveal.
// Then the concrete texture's stains, pinholes and tie-rod marks sit on top of all three.
//
// EVERY SURFACE IS OCCLUDED AT ITS JUNCTIONS. `wedge()` bakes the corner darkening into the vertex
// colours of the floor, the ceiling and the plaster. It is not a substitute for the screen-space
// AO the post chain does — it is what survives when the `low` tier switches that off, and it is
// what stops the room looking like six untouched planes at any tier.
//
// THE HALLWAY IS A LIGHT TRAP, NOT A HOLE. Behind the doorway there is a real 1.9 m corridor with
// its own floor, ceiling, side walls and a sealed end. Its plaster carries a baked gradient from
// 0.34 luminance at the threshold down to 0.09 at the far end, and a doorway-shaped warm emissive
// panel on the +X wall implies a lit room around the corner. That gradient is the only reason the
// opening reads as depth: an unlit black rectangle in a wall reads as a texture error.

import {
  chamferBox, paramSurface, prism, chamferProfile,
  surfaceMaterial, fbm2, noise2, smoothstep, clamp01, mix,
} from './geom.js';

/** 1 at distance >= reach, falling to `floorV` at distance 0. The generic junction occlusion. */
function wedge(d, reach, floorV) {
  return mix(floorV, 1, smoothstep(0, reach, d));
}

/** A regular polygon profile, for the ceiling rose and the pipe collars. */
function circleProfile(r, seg = 20) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

const SEG_BY_TIER = {
  low: { floor: [14, 16], ceil: [16, 34], wall: 4, hall: 6 },
  medium: { floor: [24, 28], ceil: [26, 62], wall: 7, hall: 8 },
  high: { floor: [42, 50], ceil: [48, 128], wall: 12, hall: 12 },
  ultra: { floor: [56, 66], ceil: [64, 172], wall: 14, hall: 14 },
};

/**
 * @param {object} ctx
 * @param {object} batch the shared geometry batcher
 * @param {Array} colliders push `{ name, pos, size }` descriptors here
 */
export function buildShell(ctx, batch, colliders) {
  const L = ctx.layout;
  const R = L.room;
  const W = L.walls;
  const C = L.ceiling;
  const B = L.beam;
  const D = L.doorway;
  const H = L.hallway;
  const tier = ctx.quality?.tier || 'high';
  const S = SEG_BY_TIER[tier] || SEG_BY_TIER.high;

  const floorMat = surfaceMaterial(ctx, 'floor.wood');
  const plasterMat = surfaceMaterial(ctx, 'plaster.wall');
  const ceilMat = surfaceMaterial(ctx, 'concrete.ceiling');
  const beamMat = surfaceMaterial(ctx, 'concrete.beam');
  const roseMat = surfaceMaterial(ctx, 'metal.blackAnodised', { tint: 0x141518 });
  // The corridor: same plaster stock, pushed dark and slightly cool. The gradient itself lives in
  // the vertex colours; this only sets the ceiling of the range.
  const hallMat = surfaceMaterial(ctx, 'plaster.wall', { tint: 0xc9c6c0 });
  const hallFloorMat = surfaceMaterial(ctx, 'floor.wood', { tint: 0x8f7a63 });
  const spillMat = surfaceMaterial(ctx, 'plaster.wall', {
    tint: 0xf3dfbe, emissive: 0xffb163, emissiveIntensity: 0.34,
  });

  // Outer extents: the floor and slab run out over the wall thickness so the room is a sealed
  // box with no light leaking through the 3 mm arris chamfers at the wall heads.
  const ox0 = W.outerMinX;
  const ox1 = W.outerMaxX;
  const oz0 = W.outerMinZ;
  const oz1 = W.outerMaxZ;

  // ── the floor ───────────────────────────────────────────────────────────────────────────────
  // Planks run along Z (toward the window), so the raking light crosses the seams rather than
  // running down them. UVs are metres: u along the 2.40 m plank length, v across the 0.19 m boards.
  {
    const [su, sv] = S.floor;
    const geo = paramSurface(su, sv, (a, b, o) => {
      const x = mix(ox0, ox1, a);
      const z = mix(oz0, oz1, b);
      // A screed is never flat. Two octaves at ~0.9 m and ~2.6 m, ±1.4 mm.
      const und = (fbm2(x * 1.1, z * 1.1, 0x5c12, 2) - 0.5) * 2 * L.floor.undulation;
      o.x = x;
      o.y = und;
      o.z = z;
      o.u = z - oz0;
      o.v = x - ox0;
      const dw = Math.min(x - R.minX, R.maxX - x, z - R.minZ, R.maxZ - z);
      // Junction occlusion, plus the fine dust line that collects in the last 60 mm.
      const ao = wedge(dw, 0.52, 0.58) * mix(0.86, 1, smoothstep(0, 0.06, dw));
      // Long-wavelength wear: traffic lanes are very slightly lighter and smoother.
      const wear = 1 + (fbm2(x * 0.32 + 11, z * 0.32, 0x5c99, 2) - 0.5) * 0.07;
      const c = clamp01(ao * wear);
      o.r = c; o.g = c * 0.995; o.b = c * 0.985;
    }, { flip: true, name: 'room.floor' });
    batch.add(geo, floorMat, { cast: false, recv: true });
  }
  colliders.push({
    name: 'room.floor',
    pos: [R.cx, -0.10, R.cz],
    size: [R.width + 2 * W.thickness, 0.20, R.depth + 2 * W.thickness],
    friction: 0.85,
  });

  // ── the ceiling slab ────────────────────────────────────────────────────────────────────────
  {
    const [su, sv] = S.ceil;
    const bw = C.boardWidth;
    const geo = paramSurface(su, sv, (a, b, o) => {
      const x = mix(ox0, ox1, a);
      const z = mix(oz0, oz1, b);
      // (1) structural sag — a shallow bowl pinned at the walls.
      const nx = (x - R.cx) / (R.width * 0.5);
      const nz = (z - R.cz) / (R.depth * 0.5);
      const bowl = Math.max(0, (1 - nx * nx)) * Math.max(0, (1 - nz * nz));
      // (2) the 300 mm formwork rhythm: each board bows, each joint hangs proud.
      const frac = ((z - R.minZ) / bw) % 1;
      const board = (Math.cos(frac * Math.PI * 2) * 0.5 + 0.5);
      // (3) casting noise on top of both.
      const grain = (fbm2(x * 1.9, z * 1.9, 0x1101, 2) - 0.5) * 0.0018;
      o.x = x;
      o.y = C.y - bowl * C.sag - board * C.boardRelief + grain;
      o.z = z;
      o.u = x - ox0;
      o.v = z - oz0;

      const dw = Math.min(x - R.minX, R.maxX - x, z - R.minZ, R.maxZ - z);
      let ao = wedge(dw, 0.62, 0.62);
      // Hard occlusion into the reveal either side of the downstand beam.
      const dBeam = Math.min(Math.abs(z - B.z0), Math.abs(z - B.z1));
      if (z > B.z0 - 0.55 && z < B.z1 + 0.55) ao *= wedge(dBeam, 0.5, 0.66);
      // Damp is worse toward the near half and the window edge, exactly as in the reference.
      const damp = 1 - smoothstep(0.45, 0.95, fbm2(x * 0.42, z * 0.34, 0x1177, 3)) * 0.10;
      const c = clamp01(ao * damp);
      o.r = c; o.g = c; o.b = c * 1.004;
    }, { flip: false, name: 'room.ceiling' });
    batch.add(geo, ceilMat, { cast: false, recv: true });
  }
  colliders.push({
    name: 'room.ceilingSlab',
    pos: [R.cx, C.y + 0.10, R.cz],
    size: [R.width + 2 * W.thickness, 0.20, R.depth + 2 * W.thickness],
  });

  // ── the downstand beam ──────────────────────────────────────────────────────────────────────
  // Real geometry with a crisp 2 mm arris. Its soffit is the darkest large surface at the window
  // end of the room and it is what makes the ceiling read as cast, not as a printed plane.
  {
    const geo = chamferBox(B.w, B.h, B.d, B.arris, {
      seg: [Math.max(6, Math.round(B.w / 0.22)), 3, 3],
      at: [B.cx, B.y, B.z],
      skip: ['+y'], // buried in the slab
      name: 'room.beam',
      colour: (lx, ly, lz, nx, ny) => {
        const y = ly + B.y;
        const z = lz + B.z;
        // Soffit is occluded toward the slab either side; the two vertical cheeks are darker still.
        let c = ny < -0.5 ? 0.80 : 0.66;
        c *= wedge(Math.min(B.y1 - y, y - B.y0) + 0.02, 0.30, 0.78);
        c *= 1 + (noise2(z * 3.1, (lx + B.cx) * 1.4, 0x3311) - 0.5) * 0.05;
        c = clamp01(c);
        return [c, c, c * 1.01];
      },
    });
    batch.add(geo, beamMat, { pos: [B.cx, B.y, B.z], cast: true, recv: true });
  }
  colliders.push({ name: 'room.beam', pos: [B.cx, B.y, B.z], size: [B.w, B.h, B.d] });

  // ── the ceiling rose ────────────────────────────────────────────────────────────────────────
  {
    const rose = C.rose;
    const disc = prism(chamferProfile(circleProfile(rose.radius, 22), 0.0025), rose.thickness, {
      name: 'room.rose',
      colour: () => [0.9, 0.9, 0.92],
    });
    batch.add(disc, roseMat, {
      pos: [rose.x, rose.y - rose.thickness * 0.5, rose.z],
      rot: [Math.PI / 2, 0, 0],
      cast: false, recv: true,
    });
    // The flex grommet, so the cord does not appear to pierce a flat disc.
    const collar = prism(circleProfile(0.011, 12), 0.010, { name: 'room.roseCollar' });
    batch.add(collar, roseMat, {
      pos: [rose.x, rose.y - rose.thickness - 0.004, rose.z],
      rot: [Math.PI / 2, 0, 0],
      cast: false, recv: false,
    });
  }

  // ── plaster walls ───────────────────────────────────────────────────────────────────────────
  // Skirting-free: this is a concrete-and-plaster apartment, the plaster dies straight into the
  // floor. That junction is where the dirt line and the darkest occlusion live.
  const wallColour = (wx, wy, wz, nx, ny, nz) => {
    // Distance to the nearest perpendicular surface: floor, slab, or another wall.
    const dFloor = wy - R.floorY;
    const dCeil = R.height - wy;
    let dSide = 6;
    if (Math.abs(nx) > 0.5) dSide = Math.min(Math.abs(wz - R.minZ), Math.abs(wz - R.maxZ));
    else if (Math.abs(nz) > 0.5) dSide = Math.min(Math.abs(wx - R.minX), Math.abs(wx - R.maxX));
    let c = wedge(dFloor, 0.42, 0.60) * wedge(dCeil, 0.34, 0.66) * wedge(dSide, 0.40, 0.68);
    // A hint of scuff and roller variation so a 6.8 m wall is not one flat value.
    c *= 1 + (fbm2(wx * 0.7, wy * 0.7 + wz * 0.13, 0x2202, 3) - 0.5) * 0.055;
    // Skirting-free walls always carry a faint grey wash in the bottom 150 mm.
    c *= mix(0.90, 1, smoothstep(0, 0.16, dFloor));
    c = clamp01(c);
    return [c, c * 0.998, c * 0.99];
  };

  const wallSeg = S.wall;
  /**
   * @param {string} name
   * @param {number[]} min [x0,y0,z0]
   * @param {number[]} max [x1,y1,z1]
   * @param {number[]} [extraSeg]
   * @param {string} [tag] forces this wall into its own mesh — see the `cutaway` note in room.js
   */
  const addWall = (name, min, max, extraSeg, tag) => {
    const w = max[0] - min[0];
    const h = max[1] - min[1];
    const d = max[2] - min[2];
    const cx = (min[0] + max[0]) * 0.5;
    const cy = (min[1] + max[1]) * 0.5;
    const cz = (min[2] + max[2]) * 0.5;
    const seg = extraSeg || [
      Math.max(1, Math.round(w / 0.28)),
      Math.max(1, Math.min(wallSeg, Math.round(h / 0.26))),
      Math.max(1, Math.round(d / 0.28)),
    ];
    const geo = chamferBox(w, h, d, W.arris, {
      seg,
      at: [cx, cy, cz],
      name,
      colour: (lx, ly, lz, nx, ny, nz) => wallColour(lx + cx, ly + cy, lz + cz, nx, ny, nz),
    });
    batch.add(geo, plasterMat, { pos: [cx, cy, cz], cast: true, recv: true, tag });
    colliders.push({ name, pos: [cx, cy, cz], size: [w, h, d] });
  };

  // Left wall — the shelving run leans against this one.
  addWall('room.wall.left', [ox0, 0, oz0], [R.minX, R.height, oz1]);
  // Right wall — the sofa sits against this one.
  addWall('room.wall.right', [R.maxX, 0, oz0], [ox1, R.height, oz1]);
  // Back wall, in three pieces around the doorway. The side faces of the two big pieces ARE the
  // door reveals, so the jambs get their chamfered arris for free. All three are tagged `back` so
  // that they merge into their own mesh and room.js can cut them away when the camera is behind
  // them — which is where the reference photograph was taken from.
  addWall('room.wall.back.a', [R.minX, 0, R.maxZ], [D.x0, R.height, oz1], null, 'back');
  addWall('room.wall.back.b', [D.x1, 0, R.maxZ], [R.maxX, R.height, oz1], null, 'back');
  addWall('room.wall.back.lintel', [D.x0, D.height, R.maxZ], [D.x1, R.height, oz1], null, 'back');
  // The window wall: the solid pier left of the glazing, plus the head and sill returns.
  addWall('room.wall.pier', [R.minX, 0, oz0], [L.glazing.x0, R.height, R.minZ]);
  addWall('room.wall.head', [L.glazing.x0, L.glazing.headY, oz0], [L.glazing.x1, R.height, R.minZ]);
  addWall('room.wall.sill', [L.glazing.x0, 0, oz0], [L.glazing.x1, L.glazing.sillY, R.minZ]);

  // ── the hallway ─────────────────────────────────────────────────────────────────────────────
  // A real volume, sealed, with a baked light gradient. `t` runs 0 at the threshold to 1 at the
  // dead end; `spill` is the warm bounce from the implied doorway on the +X side.
  const hallLum = (x, y, z) => {
    const t = clamp01((z - H.z0) / (H.z1 - H.z0));
    let c = mix(0.34, 0.085, t * t * 0.85 + t * 0.15);
    const sp = H.spill;
    const dz = Math.max(0, Math.max(sp.z0 - z, z - sp.z1));
    const dx = Math.abs(x - sp.x);
    const dy = Math.max(0, Math.max(sp.y0 - y, y - sp.y1));
    const dist = Math.hypot(dx, dz, dy * 0.6);
    c += 0.42 * Math.exp(-(dist * dist) / 1.1);
    // Floor bounce lifts the bottom 400 mm a touch.
    c *= mix(1.18, 1, smoothstep(0, 0.45, y));
    c = clamp01(c);
    return c;
  };
  const hallColour = (x, y, z) => {
    const c = hallLum(x, y, z);
    // Warm, because the only light in there is a domestic bulb around the corner.
    return [c * 1.0, c * 0.94, c * 0.84];
  };

  const addHallBox = (name, min, max, seg) => {
    const w = max[0] - min[0];
    const h = max[1] - min[1];
    const d = max[2] - min[2];
    const cx = (min[0] + max[0]) * 0.5;
    const cy = (min[1] + max[1]) * 0.5;
    const cz = (min[2] + max[2]) * 0.5;
    const geo = chamferBox(w, h, d, W.arris, {
      seg: seg || [
        Math.max(1, Math.round(w / 0.3)),
        Math.max(2, Math.min(S.hall, Math.round(h / 0.24))),
        Math.max(1, Math.min(S.hall, Math.round(d / 0.24))),
      ],
      at: [cx, cy, cz],
      name,
      colour: (lx, ly, lz) => hallColour(lx + cx, ly + cy, lz + cz),
    });
    batch.add(geo, hallMat, { pos: [cx, cy, cz], cast: true, recv: true });
    colliders.push({ name, pos: [cx, cy, cz], size: [w, h, d] });
  };

  // Everything in the corridor starts at the back wall's OUTER face. Butting it against the inner
  // face instead would put two coplanar -Z faces on the wall you look straight at, and the
  // z-fighting shimmer on that one strip would be the first thing a reviewer notices.
  const ht = H.wallThickness;
  addHallBox('hall.wall.left', [H.x0 - ht, 0, oz1], [H.x0, H.height, H.z1 + ht]);
  addHallBox('hall.wall.right', [H.x1, 0, oz1], [H.x1 + ht, H.height, H.z1 + ht]);
  addHallBox('hall.wall.end', [H.x0 - ht, 0, H.z1], [H.x1 + ht, H.height, H.z1 + ht]);
  // The corridor ceiling is a solid box, not a plane: it seals the void between the 2.34 m
  // corridor head and the 2.78 m slab, which would otherwise be a light leak straight to the sky.
  addHallBox('hall.ceiling', [H.x0 - ht, H.height, oz1], [H.x1 + ht, R.height, H.z1 + ht],
    [6, 2, 8]);

  // Hallway floor — continues the room's boards, dropped to a fraction of the luminance.
  {
    const geo = paramSurface(6, Math.max(6, S.hall), (a, b, o) => {
      const x = mix(H.x0, H.x1, a);
      const z = mix(oz1, H.z1, b);
      o.x = x;
      o.y = 0;
      o.z = z;
      o.u = z - oz0;
      o.v = x - ox0;
      const c = hallLum(x, 0.0, z) * 0.92;
      o.r = c; o.g = c * 0.95; o.b = c * 0.87;
    }, { flip: true, name: 'hall.floor' });
    batch.add(geo, hallFloorMat, { cast: false, recv: true });
  }
  colliders.push({
    name: 'hall.floor',
    pos: [(H.x0 + H.x1) * 0.5, -0.10, (oz1 + H.z1) * 0.5],
    size: [H.width, 0.20, H.z1 - oz1],
    friction: 0.85,
  });

  // The light trap itself: a doorway-shaped warm panel set 20 mm proud of the +X corridor wall,
  // with a soft top and bottom so it reads as spill rather than as a glowing rectangle.
  {
    const sp = H.spill;
    const geo = paramSurface(4, 10, (a, b, o) => {
      const z = mix(sp.z0, sp.z1, a);
      const y = mix(sp.y0, sp.y1, b);
      o.x = sp.x - 0.018;
      o.y = y;
      o.z = z;
      o.u = z; o.v = y;
      // Bright at the floor (that is where a spill lands), falling off up the jamb.
      const c = clamp01((1 - smoothstep(0.25, 1.0, b)) * 0.85 + 0.15)
        * (0.75 + 0.25 * (1 - Math.abs(a * 2 - 1)));
      o.r = c; o.g = c * 0.87; o.b = c * 0.66;
    }, { flip: false, name: 'hall.spill' });
    batch.add(geo, spillMat, { cast: false, recv: false });
  }

  return { floorMat, plasterMat, ceilMat };
}

/** Exposed for anyone debugging the shell's per-tier subdivision. */
export const SHELL_SEGMENTS = SEG_BY_TIER;
