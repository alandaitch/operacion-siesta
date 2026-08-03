// FURN · the black espresso machine on the low unit at the near end of the shelving run.
//
// It gets its own review shot from a metre away, so it is modelled as the four things that
// actually identify an espresso machine at a glance and nothing else: the chrome group head with a
// portafilter locked into it at the 20° it ends up at when you tighten it, the perforated drip
// tray sticking out of the front, the pressure gauge, and the steam wand hanging off the side.
//
// Two details do most of the work. The body is matte black anodised aluminium at roughness
// 0.28–0.46 — not 0.9; matte black metal is still metal, and the long soft highlight down its
// shoulder is the only thing separating it from a black plastic box. And every chrome piece is a
// lathe or a swept tube rather than a cylinder primitive, so the portafilter's rim, the group
// head's collar and the gauge bezel each catch a separate bright line off the window behind them.

import * as THREE from 'three';
import { chamferBox, lathe, tubeThrough, projectUV, scaleUV, xform, mergeParts, shadows, DEG } from './geo.js';

const BODY_W = 0.262;   // along x — depth, front to back
const BODY_D = 0.246;   // along z — width
const BODY_H = 0.286;
const FEET_H = 0.009;
const FRONT = BODY_W * 0.5;

/** A lathe whose axis points along +X instead of +Y. */
function lieDown(geo, x, y, z, roll = 0) {
  return xform(geo, { pos: [x, y, z], rot: [roll, 0, -Math.PI * 0.5] });
}

export function buildEspresso(kit, origin, yaw) {
  const group = new THREE.Group();
  group.name = 'espresso';
  group.position.set(origin[0], origin[1], origin[2]);
  group.rotation.y = yaw;
  group.rotation.z = 0.6 * DEG;   // one foot on a crumb

  const tmBlack = kit.tm('metal.blackAnodised');
  const tmChrome = kit.tm('metal.chrome');
  const black = kit.unit('metal.blackAnodised');
  const chrome = kit.unit('metal.chrome');
  const dark = kit.mat('plastic.matte');
  const uvBlack = { def: [tmBlack[0], tmBlack[1], false] };
  const detailed = kit.atLeast('medium');

  const bodyParts = [];
  const chromeParts = [];
  const darkParts = [];

  // --- carcass --------------------------------------------------------------------------
  bodyParts.push(xform(projectUV(chamferBox(BODY_W, BODY_H, BODY_D, 0.010, 2), uvBlack), {
    pos: [0, FEET_H + BODY_H * 0.5, 0],
  }));
  // The crown: a separate pressed cap with a big radius, so there is a real shadow line where it
  // meets the body instead of one continuous extruded box.
  bodyParts.push(xform(projectUV(chamferBox(BODY_W - 0.012, 0.060, BODY_D - 0.010, 0.024, 3), uvBlack), {
    pos: [0, FEET_H + BODY_H + 0.026, 0],
  }));
  // A recessed front panel: 4 mm proud, which is what catches the window light.
  bodyParts.push(xform(projectUV(chamferBox(0.006, 0.196, BODY_D - 0.040, 0.002, 1), uvBlack), {
    pos: [FRONT + 0.001, FEET_H + 0.150, 0],
  }));

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      darkParts.push(lathe([
        [0.0000, 0.0000],
        [0.0140, 0.0000],
        [0.0150, 0.0030],
        [0.0135, FEET_H],
        [0.0000, FEET_H],
      ], 10, 0.2, 0.2).translate(sx * (BODY_W * 0.5 - 0.026), 0, sz * (BODY_D * 0.5 - 0.026)));
    }
  }

  // --- cup rail on the crown --------------------------------------------------------------
  const railTop = FEET_H + BODY_H + 0.058;
  const railPts = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const a = Math.PI * (0.12 + t * 0.76);
    railPts.push(new THREE.Vector3(
      Math.cos(a * 2 - Math.PI * 0.5) * 0.075,
      railTop + Math.sin(t * Math.PI) * 0.006,
      (t - 0.5) * (BODY_D - 0.075),
    ));
  }
  chromeParts.push(scaleUV(tubeThrough(railPts, 0.0035, { radialSegments: 5 }), 6, 0.4));

  // --- group head + portafilter ------------------------------------------------------------
  // The group head faces DOWN out of the front shoulder; the portafilter is a cup held under it
  // with the handle out toward whoever is making the coffee.
  const headY = FEET_H + 0.150;
  const headX = FRONT - 0.014;
  chromeParts.push(lathe([
    [0.0000, headY],
    [0.0300, headY + 0.001],
    [0.0312, headY + 0.010],
    [0.0300, headY + 0.020],
    [0.0268, headY + 0.026],
    [0.0270, headY + 0.046],
    [0.0330, headY + 0.052],
    [0.0338, headY + 0.070],
    [0.0000, headY + 0.072],
  ], detailed ? 26 : 14, tmChrome[0], tmChrome[1]).translate(headX, 0, 0));

  const pf = new THREE.Group();
  pf.name = 'espresso.portafilter';
  pf.position.set(headX, headY - 0.006, 0);
  pf.rotation.y = -19 * DEG;   // where it ends up when you tighten it
  group.add(pf);

  // The basket: a real cup section, outside up and inside back down.
  const basket = lathe([
    [0.0000, -0.0060],
    [0.0250, -0.0050],
    [0.0292, 0.0010],
    [0.0296, 0.0270],
    [0.0300, 0.0325],
    [0.0272, 0.0330],
    [0.0264, 0.0060],
    [0.0230, 0.0030],
    [0.0000, 0.0025],
  ], detailed ? 24 : 12, tmChrome[0], tmChrome[1]);
  const ears = [];
  for (const a of [-1.5708, 1.5708, 3.1416]) {
    ears.push(xform(chamferBox(0.020, 0.008, 0.011, 0.002, 1), {
      pos: [Math.cos(a) * 0.033, 0.024, Math.sin(a) * 0.033], rot: [0, -a, 0],
    }));
  }
  const spouts = [];
  for (const sz of [-1, 1]) {
    spouts.push(lathe([
      [0.0000, -0.0300],
      [0.0034, -0.0295],
      [0.0042, -0.0210],
      [0.0062, -0.0110],
      [0.0080, -0.0050],
      [0.0000, -0.0045],
    ], 10, 0.2, 0.2).translate(0, 0, sz * 0.012));
  }
  // The handle: a turned bakelite grip on the +x side, drooping 5°.
  const handleGeo = xform(lathe([
    [0.0000, 0.0300],
    [0.0140, 0.0305],
    [0.0136, 0.0400],
    [0.0118, 0.0640],
    [0.0132, 0.0900],
    [0.0128, 0.1130],
    [0.0086, 0.1195],
    [0.0000, 0.1200],
  ], detailed ? 18 : 10, 0.2, 0.2), { pos: [0, 0.012, 0], rot: [0, 0, -Math.PI * 0.5 - 5 * DEG] });

  pf.add(kit.mesh(mergeParts([basket, ...ears, ...spouts]), chrome, 'espresso.portafilter.basket'));
  pf.add(kit.mesh(handleGeo, dark, 'espresso.portafilter.handle'));

  // --- drip tray ----------------------------------------------------------------------------
  const trayY = FEET_H + 0.028;
  chromeParts.push(xform(projectUV(chamferBox(0.098, 0.026, 0.176, 0.004, 1), { def: [tmChrome[0], tmChrome[1], false] }), {
    pos: [FRONT + 0.030, trayY, 0],
  }));
  for (let i = 0; i < 7; i++) {
    chromeParts.push(xform(chamferBox(0.086, 0.004, 0.010, 0.0012, 1), {
      pos: [FRONT + 0.030, trayY + 0.015, -0.070 + i * 0.0233],
    }));
  }

  // --- pressure gauge -----------------------------------------------------------------------
  const gaugeY = FEET_H + 0.232;
  chromeParts.push(lieDown(lathe([
    [0.0000, 0.0000],
    [0.0300, 0.0000],
    [0.0312, 0.0040],
    [0.0300, 0.0085],
    [0.0255, 0.0090],
    [0.0000, 0.0092],
  ], detailed ? 22 : 12, tmChrome[0], tmChrome[1]), FRONT + 0.002, gaugeY, 0));
  const dial = new THREE.CircleGeometry(0.0255, 22);
  dial.rotateY(Math.PI * 0.5);
  dial.translate(FRONT + 0.0088, gaugeY, 0);
  group.add(kit.mesh(dial, kit.tint('ceramic.white', 0xf4f1e7, { roughRange: [0.18, 0.34] }), 'espresso.gauge.face'));

  const needle = [];
  needle.push(xform(chamferBox(0.0016, 0.0195, 0.0022, 0.0004, 1), {
    pos: [FRONT + 0.0094, gaugeY + 0.0060, -0.0077], rot: [-52 * DEG, 0, 0],
  }));
  const marks = [];
  for (let i = 0; i < 9; i++) {
    const a = (-125 + i * 31) * DEG;
    marks.push(xform(chamferBox(0.0012, 0.0042, 0.0011, 0.0003, 1), {
      pos: [FRONT + 0.0094, gaugeY + Math.cos(a) * 0.0205, Math.sin(a) * 0.0205], rot: [a, 0, 0],
    }));
  }
  group.add(kit.mesh(mergeParts(marks), dark, 'espresso.gauge.ticks'));
  group.add(kit.mesh(mergeParts(needle), kit.tint('plastic.toy', 0xc4231b, { roughRange: [0.30, 0.5] }), 'espresso.gauge.needle'));

  // --- steam wand + knob ---------------------------------------------------------------------
  const wandZ = BODY_D * 0.5;
  chromeParts.push(scaleUV(tubeThrough([
    new THREE.Vector3(-0.010, FEET_H + 0.214, wandZ - 0.020),
    new THREE.Vector3(0.010, FEET_H + 0.212, wandZ + 0.014),
    new THREE.Vector3(0.034, FEET_H + 0.180, wandZ + 0.036),
    new THREE.Vector3(0.046, FEET_H + 0.120, wandZ + 0.030),
    new THREE.Vector3(0.048, FEET_H + 0.086, wandZ + 0.022),
  ], 0.0062, { radialSegments: detailed ? 8 : 5, tubularSegments: 18 }), 8, 0.3));
  chromeParts.push(lathe([
    [0.0000, 0.0000],
    [0.0125, 0.0010],
    [0.0120, 0.0075],
    [0.0088, 0.0110],
    [0.0000, 0.0115],
  ], 12, tmChrome[0], tmChrome[1]).translate(0.048, FEET_H + 0.072, wandZ + 0.020));

  darkParts.push(lathe([
    [0.0000, 0.0000],
    [0.0170, 0.0000],
    [0.0175, 0.0060],
    [0.0160, 0.0170],
    [0.0120, 0.0195],
    [0.0000, 0.0200],
  ], detailed ? 16 : 10, 0.2, 0.2).rotateX(Math.PI * 0.5)
    .translate(-0.038, FEET_H + 0.222, wandZ - 0.002));

  // --- switch + the little red standby light --------------------------------------------------
  const rocker = xform(chamferBox(0.008, 0.020, 0.036, 0.002, 1), { pos: [FRONT + 0.006, FEET_H + 0.070, -0.062] });
  group.add(kit.mesh(rocker, kit.tint('plastic.toy', 0x9c2018, { roughRange: [0.34, 0.55] }), 'espresso.switch'));

  const led = new THREE.SphereGeometry(0.0042, 10, 6);
  led.translate(FRONT + 0.0055, FEET_H + 0.070, 0.062);
  group.add(kit.mesh(
    led, kit.tint('emissive.bulb', 0xff5a2a, { emissive: 0xff4a12, emissiveIntensity: 4.5, transmission: 0 }),
    'espresso.led', { cast: false, receive: false },
  ));

  group.add(kit.mesh(mergeParts(bodyParts), black, 'espresso.body'));
  group.add(kit.mesh(mergeParts(chromeParts), chrome, 'espresso.chrome'));
  group.add(kit.mesh(mergeParts(darkParts), dark, 'espresso.plastic'));

  shadows(group, true, true);
  return {
    group,
    dynamic: {
      shape: 'box',
      size: { x: BODY_W, y: BODY_H + FEET_H + 0.060, z: BODY_D },
      offset: new THREE.Vector3(0, (BODY_H + FEET_H + 0.060) * 0.5, 0),
      mass: 7.4,
      friction: 0.92,
      restitution: 0.04,
      linearDamping: 0.4,
      angularDamping: 0.7,
      startAsleep: true,
      material: 'metal',
    },
  };
}
