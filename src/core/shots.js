// Photo-mode camera framings.
//
// Each entry is a scripted shot used by tools/shoot.mjs to render one element of the room in
// isolation so a dedicated art reviewer can judge it. They double as the game's photo mode.
// Positions are in metres, world space (see CONTRACTS.md §2). `fov` is vertical.
//
// Keep these stable! If a framing moves, before/after comparisons become meaningless. The
// exception is a framing that is simply wrong — a camera standing inside a piece of furniture is
// not a baseline worth preserving, it is a shot that reviews the wrong object. Three were moved
// after the r06 review; each is marked and dated so the discontinuity is visible in a diff.

export const SHOTS = {
  // --- the money shot: recreates the angle of the reference photograph -------------------
  hero: { pos: [-0.15, 2.35, 4.6], target: [0.1, 0.55, -1.6], fov: 62, dof: 0 },

  // --- architecture ---------------------------------------------------------------------
  ceiling: { pos: [0.2, 1.35, 0.6], target: [0.1, 2.78, -2.6], fov: 58, dof: 0 },
  // MOVED r07: the old eye (-0.9, 1.2) stood inside the playpen (x∈[-1.4,1.4] z∈[0.7,3.3]), so
  // the 'floor' shot contained no bare floor at all — it reviewed the rug and a playpen rail.
  floor: { pos: [-2.55, 0.48, 1.35], target: [-1.05, 0.0, -1.65], fov: 55, dof: 1.8 },
  window: { pos: [0.6, 1.35, -1.5], target: [0.9, 1.25, -4.6], fov: 55, dof: 0 },
  curtains: { pos: [2.0, 1.2, -2.2], target: [2.9, 1.3, -4.5], fov: 42, dof: 2.6 },
  // MOVED r07: the old eye (-0.7, -3.3) was inside the bouclé armchair (x∈[-0.74,0.04]
  // z∈[-3.85,-3.05]) and its sightline ran down the chair's centreline, occluding the subject.
  radiator: { pos: [-2.0, 0.55, -3.05], target: [-0.7, 0.3, -4.52], fov: 38, dof: 1.95 },

  // --- the shelf wall -------------------------------------------------------------------
  shelving: { pos: [-0.6, 0.95, -0.6], target: [-3.3, 0.62, -0.9], fov: 48, dof: 2.6 },
  shelvingClose: { pos: [-2.1, 0.72, -1.1], target: [-3.3, 0.6, -1.35], fov: 38, dof: 1.2 },
  artwork: { pos: [-1.9, 1.15, 1.0], target: [-3.3, 1.05, 0.85], fov: 40, dof: 1.5 },
  espresso: { pos: [-2.1, 0.95, 2.1], target: [-3.15, 0.74, 2.25], fov: 38, dof: 1.1 },

  // --- seating --------------------------------------------------------------------------
  sofa: { pos: [-0.3, 1.05, -0.4], target: [2.6, 0.5, -0.4], fov: 55, dof: 3.0 },
  sofaClose: { pos: [1.35, 0.62, 0.5], target: [2.5, 0.45, 0.55], fov: 40, dof: 1.2 },
  armchair: { pos: [0.75, 0.85, -2.5], target: [-0.35, 0.42, -3.45], fov: 45, dof: 1.8 },
  ottoman: { pos: [-0.35, 0.7, -0.85], target: [-1.45, 0.25, -2.05], fov: 45, dof: 1.6 },
  coffeeTable: { pos: [0.15, 0.62, -1.35], target: [0.95, 0.24, -2.35], fov: 46, dof: 1.3 },
  sideTable: { pos: [0.95, 0.8, -2.5], target: [1.7, 0.42, -3.25], fov: 40, dof: 1.1 },
  rattan: { pos: [1.85, 0.85, 2.35], target: [3.0, 0.42, 3.05], fov: 44, dof: 1.5 },

  // --- the nursery zone -----------------------------------------------------------------
  playpen: { pos: [-1.5, 1.45, -0.35], target: [0.1, 0.35, 2.0], fov: 55, dof: 0 },
  playpenInside: { pos: [-0.85, 0.4, 2.45], target: [0.35, 0.18, 1.75], fov: 58, dof: 1.1 },
  toys: { pos: [-0.35, 0.5, 1.05], target: [0.3, 0.14, 1.85], fov: 44, dof: 0.9 },

  // --- greenery & light -----------------------------------------------------------------
  plants: { pos: [0.55, 1.0, -2.9], target: [1.7, 0.8, -4.2], fov: 46, dof: 1.7 },
  floorLamp: { pos: [1.7, 1.1, -2.9], target: [2.95, 1.1, -4.1], fov: 42, dof: 1.6 },
  pendant: { pos: [0.35, 1.35, 0.55], target: [0.3, 1.6, -1.2], fov: 42, dof: 1.7 },
  godrays: { pos: [-2.4, 1.5, -0.2], target: [1.6, 0.9, -4.3], fov: 58, dof: 0 },

  // --- characters -----------------------------------------------------------------------
  baby: { pos: [-0.55, 0.55, -0.15], target: [0.55, 0.30, -0.82], fov: 45, dof: 1.0, needsBaby: true },
  // MOVED r07: the old eye (1.32, -1.34) sat on the skin of the cylindrical pouf (centre
  // (0.95,-1.35), r 0.33), which filled the frame and left only the baby's crown visible. The
  // new eye is 0.80 m in FRONT of the face: PHOTO_POSE heading 1.287 puts the baby's gaze along
  // (-sin h, -cos h) = (-0.96, -0.28), so the camera sits on that ray out from the eye anchor.
  babyFace: { pos: [-0.15, 0.44, -1.02], target: [0.62, 0.40, -0.79], fov: 40, dof: 0.80, needsBaby: true },
  parent: { pos: [1.62, 0.50, 0.15], target: [1.92, 1.00, 3.35], fov: 58, dof: 0, needsParent: true },

  // --- gameplay framings ----------------------------------------------------------------
  firstPerson: { follow: 'first', fov: 62 },
  thirdPerson: { follow: 'third', fov: 50 },
};

export const REVIEW_SHOTS = Object.keys(SHOTS);

export function getShot(name) {
  return SHOTS[name] || null;
}
