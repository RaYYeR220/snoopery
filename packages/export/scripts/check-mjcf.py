#!/usr/bin/env python3
"""Loads an exported Snoopery MJCF scene in MuJoCo and checks that every part moves as exported.

For each slide/hinge joint:
  kinematic  set qpos to the lower then upper limit; the part body must translate (slide) or
             rotate (hinge) by exactly the range, along/about the joint's world axis
  room       (with --room) the world axis and anchor match the room's placement, computed here
             independently from the room JSON (Y-up yaw, then Y-up -> Z-up)
  passive    with no input for 2 s the part stays where it is (gravity, damping, friction)
  driven     a PD controller with gravity compensation, applied as generalized force, drives the
             joint to its upper limit; it must get there and the body must have moved accordingly
  limit      pushing past the upper limit must be stopped by the joint limit
  return     driving back to the lower limit must work
  coupling   no other joint moves while one is driven (relative to an undriven run)

Usage: python check-mjcf.py <scene.xml | export dir | export.zip> [--room room.json] [--out report.txt]
Exit status 0 when every check passes.
"""

import argparse
import json
import math
import os
import sys
import tempfile
import zipfile

import mujoco
import numpy as np

SETTLE_S = 2.0
DRIVE_S = 3.0
DRIVE_HZ = 4.0
REACH_TOL = 0.02  # fraction of the range
LIMIT_TOL = 0.05  # fraction of the range a hard push may overshoot by (soft constraint)
DRIFT_TOL = 0.01  # fraction of the range allowed while passive
COUPLING_TOL = 1e-4  # absolute, m or rad
KINEMATIC_TOL = 1e-6


class Report:
    def __init__(self):
        self.lines = []
        self.failures = 0
        self.checks = 0

    def say(self, text=""):
        self.lines.append(text)
        print(text)

    def check(self, ok, text):
        self.checks += 1
        if not ok:
            self.failures += 1
        self.say(f"  {'OK  ' if ok else 'FAIL'} {text}")
        return ok


def resolve_scene(path, tmp):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                target = os.path.realpath(os.path.join(tmp, name))
                if not target.startswith(os.path.realpath(tmp) + os.sep):
                    raise ValueError(f"unsafe path in archive: {name}")
            archive.extractall(tmp)
        return os.path.join(tmp, "scene.xml")
    if os.path.isdir(path):
        return os.path.join(path, "scene.xml")
    return path


def fmt_v(v):
    return "(" + ", ".join(f"{x:+.4f}" for x in v) + ")"


def quat_angle(q0, q1):
    """Angle of the rotation taking orientation q0 to q1 (MuJoCo [w, x, y, z])."""
    rel = np.empty(4)
    neg = np.empty(4)
    mujoco.mju_negQuat(neg, q0)
    mujoco.mju_mulQuat(rel, q1, neg)
    return 2.0 * math.atan2(np.linalg.norm(rel[1:]), abs(rel[0]))


def quat_axis(q0, q1):
    rel = np.empty(4)
    neg = np.empty(4)
    mujoco.mju_negQuat(neg, q0)
    mujoco.mju_mulQuat(rel, q1, neg)
    v = rel[1:] * (1.0 if rel[0] >= 0 else -1.0)
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def room_expectations(room_path):
    """World axis/anchor per joint name, from the room JSON alone."""
    with open(room_path, encoding="utf-8") as f:
        room = json.load(f)
    out = {}
    for o in room["objects"]:
        yaw = o["rotationY"]
        c, s = math.cos(yaw), math.sin(yaw)
        scale = o["scale"]

        def turn(v):
            return np.array([v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c])

        def z_up(v):
            return np.array([v[0], -v[2], v[1]])

        for j in o["joints"]:
            axis = np.array(j["axis"], dtype=float)
            axis /= np.linalg.norm(axis)
            anchor = np.array(o["position"], dtype=float) + turn(np.array(j["pivot"], dtype=float) * scale)
            out[f"{o['objectId']}__{j['part']}"] = (z_up(turn(axis)), z_up(anchor))
    return out


class Sim:
    def __init__(self, model):
        self.m = model
        self.d = mujoco.MjData(model)
        self.warnings = {}

    def reset(self):
        mujoco.mj_resetData(self.m, self.d)
        mujoco.mj_forward(self.m, self.d)

    def pose(self, body):
        return self.d.xpos[body].copy(), self.d.xquat[body].copy()

    def set_q(self, qadr, value):
        self.d.qpos[qadr] = value
        mujoco.mj_forward(self.m, self.d)

    def effective_inertia(self, dof):
        full = np.zeros((self.m.nv, self.m.nv))
        if hasattr(self.d, "qM"):
            mujoco.mj_fullM(self.m, full, self.d.qM)
        else:
            mujoco.mj_fullM(self.m, self.d, full)
        return full[dof, dof]

    def run(self, seconds, dof=None, qadr=None, target=None):
        """Steps the sim; when a target is given, a critically damped PD with gravity compensation drives `dof`."""
        steps = int(round(seconds / self.m.opt.timestep))
        if dof is not None:
            inertia = self.effective_inertia(dof)
            w = 2 * math.pi * DRIVE_HZ
            kp, kd = inertia * w * w, 2 * inertia * w
        for _ in range(steps):
            self.d.qfrc_applied[:] = 0
            if dof is not None:
                q, qd = self.d.qpos[qadr], self.d.qvel[dof]
                self.d.qfrc_applied[dof] = kp * (target - q) - kd * qd + self.d.qfrc_bias[dof]
            mujoco.mj_step(self.m, self.d)
        self.d.qfrc_applied[:] = 0
        for i, w in enumerate(self.d.warning):
            if w.number > 0:
                key = mujoco.mjtWarning(i).name
                self.warnings[key] = self.warnings.get(key, 0) + int(w.number)
        if not np.all(np.isfinite(self.d.qpos)):
            raise FloatingPointError("simulation diverged (non-finite qpos)")


def check_joint(sim, j, expect, report):
    m = sim.m
    name = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_JOINT, j)
    kind = m.jnt_type[j]
    slide = kind == mujoco.mjtJoint.mjJNT_SLIDE
    unit = "m" if slide else "rad"
    lo, hi = m.jnt_range[j]
    span = hi - lo
    body, qadr, dof = m.jnt_bodyid[j], m.jnt_qposadr[j], m.jnt_dofadr[j]
    others = [(k, m.jnt_qposadr[k]) for k in range(m.njnt) if k != j and m.jnt_type[k] in (mujoco.mjtJoint.mjJNT_SLIDE, mujoco.mjtJoint.mjJNT_HINGE)]
    report.say(f"[{'slide' if slide else 'hinge'}] {name}  range {lo:g} .. {hi:g} {unit}  limited={bool(m.jnt_limited[j])}")
    report.check(bool(m.jnt_limited[j]) and span > 0, f"limited joint with a positive range ({span:g} {unit})")

    def motion(p0, p1):
        if slide:
            return float(np.linalg.norm(p1[0] - p0[0]))
        return quat_angle(p0[1], p1[1])

    # Kinematic: the body follows the joint coordinate exactly.
    sim.reset()
    sim.set_q(qadr, lo)
    rest = sim.pose(body)
    axis = sim.d.xaxis[j].copy()
    anchor = sim.d.xanchor[j].copy()
    sim.set_q(qadr, hi)
    opened = sim.pose(body)
    moved = motion(rest, opened)
    if slide:
        direction = (opened[0] - rest[0]) / max(moved, 1e-12)
    else:
        direction = quat_axis(rest[1], opened[1])
    report.check(abs(moved - span) < KINEMATIC_TOL * max(1.0, span), f"kinematic: qpos {lo:g} -> {hi:g} moves the body {moved:.6f} {unit} (expected {span:.6f})")
    report.check(float(np.dot(direction, axis)) > 1 - 1e-6, f"kinematic: motion {'direction' if slide else 'axis'} {fmt_v(direction)} = world joint axis {fmt_v(axis)}")

    if expect is not None:
        want_axis, want_anchor = expect
        report.check(float(np.dot(axis, want_axis)) > 1 - 1e-6, f"room: world axis {fmt_v(axis)} matches the placement {fmt_v(want_axis)}")
        if not slide:
            err = float(np.linalg.norm(anchor - want_anchor))
            report.check(err < 1e-5, f"room: hinge anchor {fmt_v(anchor)} matches the placement {fmt_v(want_anchor)} (err {err:.2e} m)")

    # Passive: nothing moves on its own from the closed pose.
    sim.reset()
    sim.set_q(qadr, lo)
    sim.run(SETTLE_S)
    drift = abs(sim.d.qpos[qadr] - lo)
    report.check(drift <= DRIFT_TOL * span, f"passive {SETTLE_S:g} s at {lo:g}: drift {drift:.2e} {unit}")

    # Driven open. Other joints are compared with an undriven run of the same length, so settling
    # (e.g. a lid sinking into its soft lower limit under gravity) is not mistaken for coupling.
    sim.reset()
    sim.set_q(qadr, lo)
    sim.run(DRIVE_S)
    resting = {a: float(sim.d.qpos[a]) for _, a in others}
    sim.reset()
    sim.set_q(qadr, lo)
    start = sim.pose(body)
    sim.run(DRIVE_S, dof, qadr, hi)
    q = sim.d.qpos[qadr]
    end = sim.pose(body)
    body_moved = motion(start, end)
    report.check(abs(q - hi) <= REACH_TOL * span, f"driven to {hi:g}: q = {q:.5f} {unit} after {DRIVE_S:g} s (error {abs(q - hi) / span:.2%} of range)")
    report.check(abs(body_moved - (q - lo)) < 1e-6 * max(1.0, span) + 1e-9, f"driven: body moved {body_moved:.5f} {unit} in the world, as the joint says")
    coupled = max((abs(sim.d.qpos[a] - resting[a]) for _, a in others), default=0.0)
    report.check(coupled <= COUPLING_TOL, f"coupling: other joints moved at most {coupled:.2e} while driving")

    # Joint limit: a push well past the upper limit is stopped there.
    sim.run(DRIVE_S, dof, qadr, hi + 0.5 * span)
    q = sim.d.qpos[qadr]
    overshoot = max(0.0, q - hi)
    report.check(overshoot <= LIMIT_TOL * span, f"limit: pushed towards {hi + 0.5 * span:g}, held at q = {q:.5f} {unit} (overshoot {overshoot / span:.2%} of range)")

    # Driven closed again.
    sim.run(DRIVE_S, dof, qadr, lo)
    q = sim.d.qpos[qadr]
    report.check(abs(q - lo) <= REACH_TOL * span, f"driven back to {lo:g}: q = {q:.5f} {unit}")
    report.say()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("scene", help="scene.xml, an export directory, or an export zip")
    parser.add_argument("--room", help="room JSON the scene was exported from (enables the placement checks)")
    parser.add_argument("--out", help="also write the report to this file")
    args = parser.parse_args()

    report = Report()
    with tempfile.TemporaryDirectory() as tmp:
        scene = resolve_scene(args.scene, tmp)
        model = mujoco.MjModel.from_xml_path(scene)
        report.say(f"mujoco {mujoco.__version__}  {os.path.basename(args.scene)}")
        report.say(
            f"model: {model.nbody - 1} bodies, {model.njnt} joints, {model.ngeom} geoms, {model.nmesh} meshes, "
            f"total mass {float(np.sum(model.body_mass)):.2f} kg, timestep {model.opt.timestep:g} s"
        )
        expectations = room_expectations(args.room) if args.room else {}
        sim = Sim(model)
        sim.reset()
        sim.run(SETTLE_S)
        report.say()

        joints = [j for j in range(model.njnt) if model.jnt_type[j] in (mujoco.mjtJoint.mjJNT_SLIDE, mujoco.mjtJoint.mjJNT_HINGE)]
        report.check(len(joints) > 0, f"scene has {len(joints)} slide/hinge joints")
        if args.room:
            names = {mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, j) for j in joints}
            missing = sorted(set(expectations) - names)
            report.check(not missing, f"every room joint is in the scene{' (missing: ' + ', '.join(missing) + ')' if missing else ''}")
        report.say()
        for j in joints:
            name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, j)
            check_joint(sim, j, expectations.get(name), report)

        warnings = sim.warnings
        report.check(not warnings, f"no simulator warnings{': ' + json.dumps(warnings) if warnings else ''}")

    verdict = "PASS" if report.failures == 0 else "FAIL"
    report.say(f"RESULT: {verdict} ({report.checks - report.failures}/{report.checks} checks, {len(joints)} joints)")
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write("\n".join(report.lines) + "\n")
    return 0 if report.failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
