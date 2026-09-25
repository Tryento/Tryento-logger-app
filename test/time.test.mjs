import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tzOffsetMinutes, naiveToDate, toIso, farmDay, ddmm,
  toNaiveLocal, addDays, daysBetween, asDate,
  recordServerDate, isClockSkewed, getClockSkewMs, __resetClockSkew
} from '../src/data/time.js';

const CARACAS = 'America/Caracas';

test('offset uses the ISO sign convention, not getTimezoneOffset()', () => {
  // UTC-4 must be -240, the opposite sign to Date#getTimezoneOffset().
  assert.equal(tzOffsetMinutes(new Date('2026-09-22T12:00:00Z'), CARACAS), -240);
  assert.equal(tzOffsetMinutes(new Date('2026-01-15T12:00:00Z'), CARACAS), -240);
  assert.equal(tzOffsetMinutes(new Date('2026-09-22T12:00:00Z'), 'UTC'), 0);
});

test('offset tracks DST where it exists (sanity check on the algorithm)', () => {
  const winter = tzOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York');
  const summer = tzOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'America/New_York');
  assert.equal(winter, -300);
  assert.equal(summer, -240);
});

test('THE REGRESSION: farm day after 20:00 local is today, not tomorrow', () => {
  // 2026-09-22T00:30Z is 2026-09-21 20:30 in Caracas.
  const instant = new Date('2026-09-22T00:30:00Z');

  // What the prototype did (dataClient.js:22) — UTC, and therefore wrong:
  assert.equal(instant.toISOString().slice(0, 10), '2026-09-22');

  // What we do now:
  assert.equal(farmDay(instant), '2026-09-21');
  assert.equal(ddmm(instant), '2109');
});

test('farm day is stable across the whole local day', () => {
  // 00:00 and 23:59 farm-local on the same date must yield the same day.
  assert.equal(farmDay(naiveToDate('2026-09-21T00:00')), '2026-09-21');
  assert.equal(farmDay(naiveToDate('2026-09-21T23:59')), '2026-09-21');
});

test('naive input is interpreted as farm-local, not UTC', () => {
  // An operator typing 08:30 means 08:30 at the farm = 12:30Z at UTC-4.
  const d = naiveToDate('2026-09-22T08:30');
  assert.equal(d.toISOString(), '2026-09-22T12:30:00.000Z');
});

test('toIso carries an explicit offset so Postgres cannot reinterpret it', () => {
  const iso = toIso(new Date('2026-09-22T12:30:00Z'));
  assert.equal(iso, '2026-09-22T08:30:00-04:00');
  // Round-trips to the same instant.
  assert.equal(new Date(iso).toISOString(), '2026-09-22T12:30:00.000Z');
});

test('naive -> instant -> naive round-trips exactly', () => {
  for (const naive of ['2026-01-01T00:00', '2026-06-15T13:45', '2026-12-31T23:59']) {
    assert.equal(toNaiveLocal(naiveToDate(naive)), naive);
  }
});

test('asDate distinguishes zoned from naive strings', () => {
  // Naive -> farm-local.
  assert.equal(asDate('2026-09-22T08:30').toISOString(), '2026-09-22T12:30:00.000Z');
  // Explicit Z -> taken as given.
  assert.equal(asDate('2026-09-22T08:30:00Z').toISOString(), '2026-09-22T08:30:00.000Z');
  // Explicit offset -> taken as given.
  assert.equal(asDate('2026-09-22T08:30:00-04:00').toISOString(), '2026-09-22T12:30:00.000Z');
  // Date-only -> farm-local midnight.
  assert.equal(asDate('2026-09-22').toISOString(), '2026-09-22T04:00:00.000Z');
  assert.equal(asDate(''), null);
  assert.equal(asDate('nonsense'), null);
});

test('addDays is pure calendar arithmetic, immune to timezone', () => {
  assert.equal(addDays('2026-09-22', 180), '2027-03-21');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');   // 2026 is not a leap year
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');   // 2024 is
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

test('daysBetween', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-22'), 21);
  assert.equal(daysBetween('2026-09-22', '2026-09-01'), -21);
  assert.equal(daysBetween(null, '2026-09-01'), null);
});

test('clock skew detection', () => {
  __resetClockSkew();
  assert.equal(isClockSkewed(), false);

  recordServerDate(new Date(Date.now() - 30 * 60 * 1000).toUTCString());
  assert.ok(getClockSkewMs() > 25 * 60 * 1000, 'should detect a ~30min fast device clock');
  assert.equal(isClockSkewed(), true);

  __resetClockSkew();
  recordServerDate(new Date().toUTCString());
  assert.equal(isClockSkewed(), false);

  // Garbage must not poison the reading.
  __resetClockSkew();
  recordServerDate('not a date');
  assert.equal(getClockSkewMs(), 0);
});
