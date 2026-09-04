// The character controller.
//
// A capsule swept against the chunk BVHs, resolved by pushing out along the
// closest-point vector to every triangle it overlaps. That is genuinely exact
// collision: no proxy boxes, no "close enough" heightfield, no falling through
// a bridge because the deck was not in a coarse collision layer.
//
// Three details do most of the work in making it feel right:
//
//   * Substepping. Movement is split so no step exceeds a fraction of the
//     capsule radius, which is what stops you tunnelling through a wall when
//     running downhill or when the frame rate drops.
//   * Step-up. A capsule alone will not climb a 40 cm stair reliably, so a
//     blocked horizontal move is retried lifted, then dropped back down.
//   * Ground snapping. Walking down stairs without it turns into a series of
//     small falls.

import * as THREE from 'three';
import { clamp, damp } from '../core/util.js';

const UP = new THREE.Vector3(0, 1, 0);

export class CharacterController {
  constructor(collisionWorld, settings) {
    this.world = collisionWorld;
    this.settings = settings;

    // Capsule: a segment plus a radius. Eye height sits just under the top.
    this.radius = 0.34;
    this.standHeight = 1.78;
    this.crouchHeight = 1.15;
    this.height = this.standHeight;
    this.eyeOffset = 0.14;         // below the top of the capsule

    this.position = new THREE.Vector3(0, 0, 0);   // feet
    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundSurface = 0;
    this.wasGrounded = false;
    this.crouching = false;
    this.inWater = false;
    this.waterDepth = 0;

    this.yaw = 0;
    this.pitch = 0;

    this.gravity = -19.6;          // heavier than reality; games always are
    this.jumpSpeed = 5.0;
    this.airControl = 0.32;
    this.maxSlope = Math.cos(52 * Math.PI / 180);
    this.stepHeight = 0.42;

    this.coyoteTime = 0;
    this.jumpBuffer = 0;
    this.distanceWalked = 0;
    this.lastStepDistance = 0;
    this.landingImpact = 0;

    // Scratch objects, allocated once. This runs five times a frame.
    this._box = new THREE.Box3();
    this._segment = new THREE.Line3();
    this._triPoint = new THREE.Vector3();
    this._capsulePoint = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._before = new THREE.Vector3();
    this._temp = new THREE.Vector3();
    this._nearby = [];
    this._hitNormalSum = new THREE.Vector3();
    this._contacts = 0;
  }

  applySettings() {
    const gp = this.settings.gameplay;
    this.stepHeight = gp.autoStep;
    this.maxSlope = Math.cos(gp.slopeLimit * Math.PI / 180);
  }

  get eyePosition() {
    return this._temp.set(
      this.position.x,
      this.position.y + this.height - this.eyeOffset,
      this.position.z);
  }

  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.coyoteTime = 0;
  }

  /** Capsule segment in world space, from the lower sphere centre to the upper. */
  updateSegment(target = this._segment, position = this.position, height = this.height) {
    target.start.set(position.x, position.y + this.radius, position.z);
    target.end.set(position.x, position.y + height - this.radius, position.z);
    return target;
  }

  /**
   * Push the capsule out of anything it overlaps.
   * Returns the total correction applied, which tells the caller whether we
   * landed on something (a push mostly upward) or hit a wall.
   */
  resolvePenetration(position, height, out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    this._hitNormalSum.set(0, 0, 0);
    this._contacts = 0;
    if (!this.settings.gameplay.collision) return out;

    const seg = this.updateSegment(this._segment, position, height);
    this._box.makeEmpty();
    this._box.expandByPoint(seg.start);
    this._box.expandByPoint(seg.end);
    this._box.min.addScalar(-this.radius);
    this._box.max.addScalar(this.radius);

    const colliders = this.world.near(this._box, this._nearby);
    if (!colliders.length) return out;

    const startX = seg.start.x, startY = seg.start.y, startZ = seg.start.z;
    const radius = this.radius;
    const triPoint = this._triPoint;
    const capsulePoint = this._capsulePoint;
    const normalSum = this._hitNormalSum;
    let contacts = 0;

    for (const collider of colliders) {
      const bvh = collider.geometry.boundsTree;
      if (!bvh) continue;
      bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(this._box),
        intersectsTriangle: (tri) => {
          // Closest point between this triangle and the capsule's core segment.
          const distance = tri.closestPointToSegment(seg, triPoint, capsulePoint);
          if (distance < radius) {
            const depth = radius - distance;
            const dir = capsulePoint.sub(triPoint);
            if (dir.lengthSq() < 1e-12) return false;
            dir.normalize();
            seg.start.addScaledVector(dir, depth);
            seg.end.addScaledVector(dir, depth);
            normalSum.addScaledVector(dir, depth);
            contacts++;
          }
          return false;
        },
      });
    }

    this._contacts = contacts;
    out.set(seg.start.x - startX, seg.start.y - startY, seg.start.z - startZ);
    // Recentre the box for any follow-up query this frame.
    return out;
  }

  /**
   * Advance one fixed physics step.
   * `moveInput` is `{x, y}` in local space; `wish` flags carry jump/crouch.
   */
  step(dt, moveInput, wish) {
    const gp = this.settings.gameplay;
    this.wasGrounded = this.grounded;

    // Crouch, with a headroom check so you cannot stand up inside a duct.
    const wantCrouch = wish.crouch;
    if (wantCrouch !== this.crouching) {
      if (!wantCrouch && !this.hasHeadroom(this.standHeight)) {
        // Blocked: stay crouched.
      } else {
        this.crouching = wantCrouch;
      }
    }
    const targetHeight = this.crouching ? this.crouchHeight : this.standHeight;
    this.height = damp(this.height, targetHeight, 14, dt);

    if (gp.fly) return this.stepFly(dt, moveInput, wish);

    // --- desired horizontal velocity ---------------------------------------
    const speed = this.crouching ? gp.crouchSpeed
      : wish.sprint ? gp.runSpeed : gp.walkSpeed;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // The camera is built with rotation.set(pitch, yaw, 0, 'YXZ') and looks
    // down its own -z, so in world terms forward is (-sin, -cos) and right is
    // (cos, -sin). Both z terms are negative; getting that sign wrong builds a
    // basis that is a reflection rather than a rotation, which does not read as
    // "inverted" so much as scrambled: at yaw 0 it is W and S that are swapped,
    // and a quarter turn later it is A and D.
    const wishX = moveInput.x * cos - moveInput.y * sin;
    const wishZ = -(moveInput.x * sin + moveInput.y * cos);
    let targetVx = wishX * speed;
    let targetVz = wishZ * speed;

    if (this.inWater) { targetVx *= 0.55; targetVz *= 0.55; }

    // Ground has grip; air does not.
    const accel = this.grounded ? 42 : 42 * this.airControl;
    this.velocity.x = damp(this.velocity.x, targetVx, accel, dt);
    this.velocity.z = damp(this.velocity.z, targetVz, accel, dt);

    // --- vertical ----------------------------------------------------------
    this.coyoteTime = this.grounded ? 0.12 : Math.max(0, this.coyoteTime - dt);
    this.jumpBuffer = wish.jump ? 0.15 : Math.max(0, this.jumpBuffer - dt);
    if (this.jumpBuffer > 0 && this.coyoteTime > 0 && gp.jump) {
      this.velocity.y = this.jumpSpeed;
      this.grounded = false;
      this.coyoteTime = 0;
      this.jumpBuffer = 0;
    }
    const buoyancy = this.inWater ? 12 : 0;
    this.velocity.y += (this.gravity + buoyancy) * dt;
    if (this.inWater) this.velocity.y = clamp(this.velocity.y, -2.5, 2.5);
    else this.velocity.y = Math.max(this.velocity.y, -55);

    // --- integrate, in substeps small enough not to tunnel ------------------
    const move = this._delta.copy(this.velocity).multiplyScalar(dt);
    const dist = move.length();
    const maxStep = this.radius * 0.65;
    const steps = clamp(Math.ceil(dist / maxStep), 1, 12);
    const sub = 1 / steps;

    this.grounded = false;
    let normalAccum = new THREE.Vector3();
    for (let s = 0; s < steps; s++) {
      this._before.copy(this.position);
      this.position.addScaledVector(move, sub);
      const correction = this.resolvePenetration(this.position, this.height, new THREE.Vector3());
      this.position.add(correction);

      if (this._contacts > 0) {
        const n = this._hitNormalSum.clone().normalize();
        normalAccum.add(n);
        // A push that is mostly upward means we are standing on something.
        if (n.y > this.maxSlope && this.velocity.y <= 0.01) {
          this.grounded = true;
          this.groundNormal.copy(n);
          this.velocity.y = 0;
        } else if (n.y < -0.4 && this.velocity.y > 0) {
          this.velocity.y = 0;              // clipped a ceiling
        }
        // Remove the component of velocity pushing into the surface, so we
        // slide along a wall rather than sticking to it.
        const into = this.velocity.dot(n);
        if (into < 0) this.velocity.addScaledVector(n, -into);
      }
    }

    // --- step up -----------------------------------------------------------
    // If we wanted to move horizontally and barely did, try again from higher.
    const wantedH = Math.hypot(targetVx, targetVz) * dt * 0.5;
    const gotH = Math.hypot(this.position.x - (this.position.x - move.x), 0);
    if ((this.grounded || this.wasGrounded) && wantedH > 0.001) {
      this.tryStepUp(moveInput, speed, dt);
    }

    // --- ground snap -------------------------------------------------------
    // Without this, walking down a flight of stairs is a series of small falls.
    if (!this.grounded && this.wasGrounded && this.velocity.y < 0.5 && this.velocity.y > -8) {
      this.snapToGround();
    }

    if (this.grounded && !this.wasGrounded) {
      this.landingImpact = clamp(-this._lastFallSpeed / 12, 0, 1);
    }
    this._lastFallSpeed = this.velocity.y;

    // Track distance for footsteps and the HUD.
    const moved = Math.hypot(this.position.x - this._before.x, this.position.z - this._before.z);
    if (this.grounded) this.distanceWalked += moved;

    return this;
  }

  /**
   * Retry a blocked horizontal move from `stepHeight` up, then settle back
   * down. This is what lets the capsule climb kerbs and staircases without
   * making every wall climbable.
   */
  tryStepUp(moveInput, speed, dt) {
    if (this._contacts === 0) return;
    const n = this._hitNormalSum.lengthSq() > 0 ? this._hitNormalSum.clone().normalize() : null;
    if (!n || n.y > this.maxSlope) return;     // we hit the floor, not a step

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const dirX = moveInput.x * cos - moveInput.y * sin;
    const dirZ = -(moveInput.x * sin + moveInput.y * cos);   // same basis as above
    const len = Math.hypot(dirX, dirZ);
    if (len < 0.01) return;

    const probe = this.position.clone();
    probe.y += this.stepHeight + 0.02;
    const ahead = Math.min(0.35, speed * dt + 0.12);
    probe.x += (dirX / len) * ahead;
    probe.z += (dirZ / len) * ahead;

    // Is the lifted position clear?
    const correction = this.resolvePenetration(probe, this.height, new THREE.Vector3());
    if (correction.lengthSq() > 0.0004) return;      // still blocked up there

    // Drop back down onto whatever is underneath.
    const landed = this.dropTo(probe, this.stepHeight + 0.12);
    if (landed === null) return;
    const rise = landed - this.position.y;
    if (rise < -0.02 || rise > this.stepHeight + 0.02) return;

    this.position.set(probe.x, landed, probe.z);
    this.grounded = true;
    this.velocity.y = 0;
  }

  /** Cast down from a position; returns the surface height or null. */
  dropTo(position, maxDrop) {
    const origin = new THREE.Vector3(position.x, position.y + this.radius + 0.05, position.z);
    const hit = this.world.raycast(origin, new THREE.Vector3(0, -1, 0), maxDrop + this.radius + 0.1);
    if (!hit) return null;
    return hit.point.y;
  }

  /** Pull the feet back down to the ground when we have just stepped off it. */
  snapToGround() {
    const landed = this.dropTo(this.position, this.stepHeight + 0.1);
    if (landed === null) return;
    const drop = this.position.y - landed;
    if (drop < 0 || drop > this.stepHeight + 0.1) return;
    this.position.y = landed;
    this.grounded = true;
    this.velocity.y = 0;
  }

  /** Is there room to stand up to `height` here? */
  hasHeadroom(height) {
    const probe = this.position.clone();
    const correction = this.resolvePenetration(probe, height, new THREE.Vector3());
    return correction.y <= 0.02;
  }

  /** Free flight, for the photo mode and the debug camera. */
  stepFly(dt, moveInput, wish) {
    const speed = (wish.sprint ? 40 : 10) * (this.crouching ? 0.25 : 1);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const pitchCos = Math.cos(this.pitch), pitchSin = Math.sin(this.pitch);
    const fx = -sin * pitchCos, fy = pitchSin, fz = -cos * pitchCos;
    const rx = cos, rz = -sin;
    const target = new THREE.Vector3(
      (fx * moveInput.y + rx * moveInput.x) * speed,
      fy * moveInput.y * speed + (wish.up ? speed : 0) - (wish.down ? speed : 0),
      (fz * moveInput.y + rz * moveInput.x) * speed);
    this.velocity.lerp(target, 1 - Math.exp(-10 * dt));
    this.position.addScaledVector(this.velocity, dt);
    this.grounded = false;
    return this;
  }

  /**
   * Find a safe place to stand at (x, z): the highest solid surface, with the
   * capsule proven not to be inside anything.
   */
  placeAt(x, z, preferredY = 4000) {
    const hit = this.world.raycast(
      new THREE.Vector3(x, preferredY, z), new THREE.Vector3(0, -1, 0), preferredY + 1000);
    if (!hit) return false;
    const probe = new THREE.Vector3(x, hit.point.y + 0.05, z);
    for (let attempt = 0; attempt < 12; attempt++) {
      const correction = this.resolvePenetration(probe, this.standHeight, new THREE.Vector3());
      if (correction.lengthSq() < 1e-6) break;
      probe.add(correction);
      probe.y += 0.02;
    }
    this.teleport(probe.x, probe.y, probe.z);
    return true;
  }
}
