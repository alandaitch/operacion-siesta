// FURN · the two practicals: the cream mushroom floor lamp by the curtain, and the bare bulb on a
// black flex hanging off the slab.
//
// Both are built as real light *fittings*, because LIGHT parks a point light at whatever object we
// hand it and everything else about how they read is geometry:
//
//  · The shade is a closed lathe with a genuine 3–4 mm wall — outer surface up and over the dome,
//    inner surface back down, rim across the mouth — traversed counter-clockwise in the (r, y)
//    plane so LatheGeometry's analytic normals come out facing the right way on both sheets. That
//    thickness is what makes `emissive.lampshade`'s transmission read as a fabric shade lit from
//    inside (bright rim at the mouth, warm glow through the crown) instead of as a glowing decal.
//    It also sits 2.6° crooked on its stem, because shades always do.
//  · The bulb is an E27 A60: a real glass envelope necking into a ribbed brass screw base, a glass
//    pinch stem, two support wires and a genuinely coiled tungsten helix between them. At this
//    scale the coil is four hundred triangles and it is the difference between "a bulb" and "a
//    glowing sphere".
//  · The flex is a CHILD of the swinging body. A spherical joint pins the point (0, length, 0) of
//    the tip body to the ceiling anchor, so anything rigidly attached to that body at that point
//    stays welded to the ceiling for free — no per-frame cord rebuild, no drift, and the cord
//    stays exactly straight, which is what a taut flex under a 110 g bulb actually does.

import * as THREE from 'three';
import { lathe, tubeThrough, scaleUV, xform, mergeParts, shadows, DEG } from './geo.js';

// ─────────────────────────────────────────────────────────────── floor lamp ──

const SHADE_Y = 1.415;   // the shade's optical centre above the floor
const SHADE_R = 0.190;

export function buildFloorLamp(kit, origin) {
  const group = new THREE.Group();
  group.name = 'lamp.standing';
  group.position.set(origin[0], origin[1], origin[2]);
  group.rotation.y = kit.rand(-0.6, 0.6);

  const black = kit.unit('metal.blackAnodised');
  const brass = kit.unit('metal.brass');
  const tmB = kit.tm('metal.blackAnodised');
  const tmBr = kit.tm('metal.brass');
  const detailed = kit.atLeast('medium');

  // Weighted base: 290 mm of cast iron under a lamp is what stops it walking across the floor.
  const base = lathe([
    [0.0000, 0.0000],
    [0.1400, 0.0005],
    [0.1455, 0.0040],
    [0.1470, 0.0120],
    [0.1430, 0.0205],
    [0.1250, 0.0285],
    [0.0420, 0.0330],
    [0.0300, 0.0365],
    [0.0000, 0.0380],
  ], detailed ? 44 : 20, tmB[0], tmB[1]);

  const stem = lathe([
    [0.0000, 0.0330],
    [0.0155, 0.0335],
    [0.0150, 0.0480],
    [0.0098, 0.0620],
    [0.0094, 0.4000],
    [0.0088, 0.9000],
    [0.0083, 1.2740],
    [0.0128, 1.2820],
    [0.0126, 1.2980],
    [0.0000, 1.3000],
  ], detailed ? 20 : 12, tmB[0], tmB[1]);

  group.add(kit.mesh(mergeParts([base, stem]), black, 'lamp.standing.body'));

  // The brass collar where the shade grips the stem.
  const collar = lathe([
    [0.0000, 1.2980],
    [0.0205, 1.3000],
    [0.0215, 1.3160],
    [0.0180, 1.3300],
    [0.0110, 1.3370],
    [0.0000, 1.3380],
  ], detailed ? 20 : 12, tmBr[0], tmBr[1]);
  group.add(kit.mesh(collar, brass, 'lamp.standing.collar'));

  // The head: shade + bulb, sitting crooked.
  const head = new THREE.Group();
  head.name = 'floorLamp.head';
  head.position.set(0, SHADE_Y, 0);
  head.rotation.set(1.9 * DEG, 0, 2.6 * DEG);
  group.add(head);

  const R = SHADE_R;
  const shadeProfile = [
    [R * 0.989, -0.0450],
    [R * 1.000, -0.0300],
    [R * 0.989, -0.0060],
    [R * 0.942, 0.0300],
    [R * 0.853, 0.0620],
    [R * 0.721, 0.0900],
    [R * 0.542, 0.1140],
    [R * 0.337, 0.1290],
    [R * 0.158, 0.1350],
    [R * 0.063, 0.1366],
    [R * 0.055, 0.1336],
    [R * 0.153, 0.1320],
    [R * 0.326, 0.1262],
    [R * 0.526, 0.1112],
    [R * 0.702, 0.0875],
    [R * 0.832, 0.0600],
    [R * 0.920, 0.0285],
    [R * 0.967, -0.0070],
    [R * 0.978, -0.0300],
    [R * 0.968, -0.0450],
  ];
  shadeProfile.push(shadeProfile[0].slice()); // close the mouth rim
  const shade = kit.mesh(
    lathe(shadeProfile, detailed ? 56 : 28, 1.07, 0.30),
    kit.mat('emissive.lampshade'), 'floorLamp.shade', { cast: true, receive: false },
  );
  head.add(shade);

  // The lampholder and the bulb behind the fabric — you see them as a hot core through the shade.
  const holder = lathe([
    [0.0000, -0.0120],
    [0.0175, -0.0120],
    [0.0180, 0.0060],
    [0.0135, 0.0140],
    [0.0130, 0.0330],
    [0.0000, 0.0340],
  ], 16, tmBr[0], tmBr[1]);
  head.add(kit.mesh(holder, brass, 'floorLamp.holder', { cast: false, receive: false }));

  const bulb = new THREE.SphereGeometry(0.031, detailed ? 20 : 10, detailed ? 14 : 7);
  const bulbMesh = kit.mesh(bulb, kit.mat('emissive.bulb'), 'floorLamp.glow', { cast: false, receive: false });
  bulbMesh.position.y = -0.036;
  bulbMesh.scale.set(1, 1.12, 1);
  head.add(bulbMesh);

  // A stub of flex out of the base. The rest of the run is a separate static coil on the floor, so
  // that when the lamp goes over the cable stays where it was.
  const stubPts = [
    new THREE.Vector3(0.0, 0.014, 0.0),
    new THREE.Vector3(-0.06, 0.010, 0.03),
    new THREE.Vector3(-0.115, 0.006, 0.075),
  ];
  group.add(kit.mesh(
    scaleUV(tubeThrough(stubPts, 0.0035, { radialSegments: 5 }), 8, 1),
    kit.tint('plastic.matte', 0x1a1a1d, { roughRange: [0.45, 0.72] }), 'lamp.standing.flexStub',
  ));

  shadows(group, true, true);
  return {
    group,
    head,
    shade,
    /** A simplification: one upright cylinder, so the baby's headbutt tips it rather than sliding it. */
    dynamic: {
      shape: 'cylinder',
      radius: 0.150,
      halfHeight: 0.775,
      offset: new THREE.Vector3(0, 0.775, 0),
      mass: 4,
      friction: 0.85,
      restitution: 0.05,
      linearDamping: 0.5,
      angularDamping: 0.85,
      startAsleep: true,
      material: 'metal',
    },
  };
}

/** The loose coil of flex the lamp is plugged in with. Static, and it stays put. */
export function buildLampFlex(kit, from, to) {
  const pts = [];
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const len = Math.hypot(dx, dz);
  const ux = dx / (len || 1);
  const uz = dz / (len || 1);
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    // A shallow S with a loose loop where somebody kicked it against the skirting.
    const wander = Math.sin(t * Math.PI * 1.7) * 0.055 + Math.sin(t * 9.3) * 0.012;
    pts.push(new THREE.Vector3(
      from[0] + ux * len * t - uz * wander,
      0.0035 + Math.sin(t * 5.1) * 0.0008,
      from[2] + uz * len * t + ux * wander,
    ));
  }
  const geo = scaleUV(tubeThrough(pts, 0.0035, { radialSegments: 5 }), 26, 1);
  const mesh = kit.mesh(geo, kit.tint('plastic.matte', 0x1a1a1d, { roughRange: [0.45, 0.72] }), 'lamp.flex');
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ────────────────────────────────────────────────────────────────── pendant ──

/**
 * @param anchor world position of the ceiling rose
 * @param drop   distance from the rose down to the centre of the glass envelope
 */
export function buildPendant(kit, anchor, drop) {
  const tmBr = kit.tm('metal.brass');
  const brass = kit.unit('metal.brass');
  const detailed = kit.atLeast('high');

  // --- the fixed half: the cord grip screwed to the slab ---------------------------------
  const rose = new THREE.Group();
  rose.name = 'fitting.ceilingGrip';
  rose.position.set(anchor.x, anchor.y, anchor.z);
  const griProfile = [
    [0.0000, -0.0480],
    [0.0092, -0.0480],
    [0.0125, -0.0430],
    [0.0130, -0.0300],
    [0.0175, -0.0230],
    [0.0180, -0.0080],
    [0.0300, -0.0035],
    [0.0305, 0.0000],
    [0.0000, 0.0000],
  ];
  rose.add(kit.mesh(
    lathe(griProfile, detailed ? 22 : 12, 0.2, 0.2),
    kit.tint('plastic.matte', 0x191a1c, { roughRange: [0.42, 0.70] }), 'fitting.grip',
  ));

  // --- the swinging half -----------------------------------------------------------------
  const bulb = new THREE.Group();
  bulb.name = 'pendant.bulb';
  bulb.position.set(anchor.x, anchor.y - drop, anchor.z);

  // The flex. Its top vertex is exactly the joint anchor in the tip body's frame, so it hangs
  // from the ceiling without a single line of update code.
  const cordTop = drop;
  const cordBottom = 0.147;
  const cordPts = [];
  for (let i = 0; i <= 9; i++) {
    const t = i / 9;
    const y = cordTop + (cordBottom - cordTop) * t;
    // A memory kink from the coil it was sold on. 3 mm, and it kills the CAD-cylinder look.
    const k = Math.sin(t * Math.PI * 2.3) * 0.0032 * Math.sin(Math.PI * t);
    cordPts.push(new THREE.Vector3(k, y, k * 0.6));
  }
  const cord = scaleUV(
    tubeThrough(cordPts, 0.0038, { radialSegments: detailed ? 7 : 5, tubularSegments: 26 }),
    (cordTop - cordBottom) / 0.022, 1,
  );
  bulb.add(kit.mesh(
    cord, kit.tint('fabric.playpenTrim', 0x1b1b1e, { uvRepeat: [1, 1], roughRange: [0.55, 0.85] }),
    'pendant.cord',
  ));

  // Brass lampholder: cord nut, body, shade ring, skirt.
  const holder = lathe([
    [0.0000, 0.0450],
    [0.0122, 0.0455],
    [0.0125, 0.0620],
    [0.0180, 0.0665],
    [0.0176, 0.0900],
    [0.0212, 0.0940],
    [0.0255, 0.0985],
    [0.0250, 0.1090],
    [0.0212, 0.1140],
    [0.0208, 0.1350],
    [0.0150, 0.1420],
    [0.0125, 0.1450],
    [0.0000, 0.1470],
  ], detailed ? 28 : 14, tmBr[0], tmBr[1]);

  // E27 screw shell: six turns suggested by a ribbed profile.
  const screw = [[0.0000, 0.0400]];
  for (let i = 0; i < 6; i++) {
    const y = 0.0400 + i * 0.0035;
    screw.push([0.0136, y], [0.0129, y + 0.0018]);
  }
  screw.push([0.0132, 0.0620], [0.0000, 0.0625]);
  const screwGeo = lathe(screw, detailed ? 24 : 12, tmBr[0], tmBr[1]);
  bulb.add(kit.mesh(mergeParts([holder, screwGeo]), brass, 'pendant.holder'));

  // The glass envelope. A60: 60 mm across the bulge, necking into the base.
  const glass = lathe([
    [0.0000, -0.0580],
    [0.0125, -0.0572],
    [0.0212, -0.0525],
    [0.0272, -0.0430],
    [0.0298, -0.0280],
    [0.0301, -0.0090],
    [0.0290, 0.0090],
    [0.0248, 0.0240],
    [0.0180, 0.0335],
    [0.0148, 0.0395],
    [0.0142, 0.0450],
    [0.0000, 0.0460],
  ], detailed ? 40 : 20, 0.3, 0.3);
  const glassMesh = kit.mesh(glass, kit.mat('emissive.bulb'), 'pendant.glass', { cast: false, receive: false });
  glassMesh.renderOrder = 3;
  bulb.add(glassMesh);

  // Pinch stem, support wires, filament.
  const hot = kit.tint('emissive.bulb', 0xfff4de, {
    emissive: 0xffb257, emissiveIntensity: 16, transmission: 0, opacity: 1, roughness: 0.42,
  });
  const stemGlass = kit.tint('emissive.bulb', 0xeef0ec, {
    emissive: 0x2a2418, emissiveIntensity: 0.35, transmission: 0.25,
  });
  const stem = lathe([
    [0.0000, -0.0080],
    [0.0062, -0.0100],
    [0.0068, -0.0035],
    [0.0034, 0.0055],
    [0.0031, 0.0400],
    [0.0000, 0.0420],
  ], detailed ? 14 : 8, 0.2, 0.2);
  bulb.add(kit.mesh(stem, stemGlass, 'pendant.stem', { cast: false, receive: false }));

  const wires = [];
  for (const s of [-1, 1]) {
    wires.push(tubeThrough([
      new THREE.Vector3(s * 0.0035, -0.0060, 0),
      new THREE.Vector3(s * 0.0086, -0.0140, 0),
      new THREE.Vector3(s * 0.0082, -0.0245, 0),
    ], 0.00055, { radialSegments: 3 }));
  }
  const filament = [];
  if (detailed) {
    // A real tungsten coil: 15 turns of 5 mm radius strung between the two support tips.
    const pts = [];
    const turns = 15;
    const per = 8;
    for (let i = 0; i <= turns * per; i++) {
      const t = i / (turns * per);
      const a = t * turns * Math.PI * 2;
      pts.push(new THREE.Vector3(
        -0.0082 + t * 0.0164,
        -0.0245 + Math.sin(a) * 0.0022,
        Math.cos(a) * 0.0022,
      ));
    }
    filament.push(tubeThrough(pts, 0.00042, { radialSegments: 3, tubularSegments: turns * per }));
  } else {
    filament.push(tubeThrough([
      new THREE.Vector3(-0.0082, -0.0245, 0),
      new THREE.Vector3(0, -0.0262, 0),
      new THREE.Vector3(0.0082, -0.0245, 0),
    ], 0.0006, { radialSegments: 3 }));
  }
  bulb.add(kit.mesh(mergeParts(wires), brass, 'pendant.supports', { cast: false, receive: false }));
  bulb.add(kit.mesh(mergeParts(filament), hot, 'pendant.filament', { cast: false, receive: false }));

  // What LIGHT tracks: the filament itself, not the fitting 13 cm above it.
  const emitter = new THREE.Object3D();
  emitter.name = 'pendant.emitter';
  emitter.position.set(0, -0.024, 0);
  bulb.add(emitter);

  shadows(rose, true, false);
  return {
    rose,
    bulb,
    emitter,
    pendulum: {
      anchor: { x: anchor.x, y: anchor.y, z: anchor.z },
      length: drop,
      segments: 1,
      radius: 0.036,
      mass: 0.11,
      shape: 'ball',
      linearDamping: 0.16,
      angularDamping: 0.45,
      friction: 0.4,
      restitution: 0.06,
      material: 'glass',
    },
  };
}
