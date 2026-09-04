// Solar and lunar position.
//
// The sun is placed by the NOAA solar position algorithm from the real date,
// time and coordinates, so midsummer in Reykjavik genuinely never gets dark and
// the shadows in Nairobi genuinely go almost straight down at noon. Anything
// less would undercut the point of walking around the actual Earth.
//
// Deliberately free of any rendering dependency so it can be unit tested
// against published almanac values.
//
// Reference: NOAA Solar Calculator, itself following Meeus, Astronomical
// Algorithms (2nd ed.), chapters 12, 22, 25 and 47.

import { DEG, RAD, clamp } from '../core/util.js';

/** Julian day number for a Date, in UTC. */
export function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Julian centuries since J2000.0. */
export function julianCentury(jd) {
  return (jd - 2451545) / 36525;
}

/**
 * Solar position for a moment and place.
 *
 * Returns azimuth in degrees clockwise from north, elevation in degrees above
 * the horizon (refraction-corrected), plus the values a caller might want for
 * twilight logic and sunrise/sunset.
 */
export function solarPosition(date, lat, lon) {
  const jd = julianDay(date);
  const t = julianCentury(jd);

  // Geometric mean longitude and anomaly of the sun.
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const Mrad = M * DEG;

  // Equation of centre, giving the true longitude.
  const C = Math.sin(Mrad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
            Math.sin(2 * Mrad) * (0.019993 - 0.000101 * t) +
            Math.sin(3 * Mrad) * 0.000289;
  const trueLong = L0 + C;

  // Apparent longitude, corrected for nutation and aberration.
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // Obliquity of the ecliptic.
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  let epsilon = 23 + (26 + seconds / 60) / 60;
  epsilon += 0.00256 * Math.cos(omega * DEG);
  const epsRad = epsilon * DEG;

  const declination = Math.asin(Math.sin(epsRad) * Math.sin(lambda * DEG)) * RAD;

  // Equation of time, in minutes.
  const y = Math.tan(epsRad / 2) ** 2;
  const L0rad = L0 * DEG;
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const eqTime = 4 * RAD * (
    y * Math.sin(2 * L0rad) -
    2 * eccentricity * Math.sin(Mrad) +
    4 * eccentricity * y * Math.sin(Mrad) * Math.cos(2 * L0rad) -
    0.5 * y * y * Math.sin(4 * L0rad) -
    1.25 * eccentricity * eccentricity * Math.sin(2 * Mrad)
  );

  // True solar time, then the hour angle.
  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes() +
                     date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;
  let trueSolarTime = (minutesUtc + eqTime + 4 * lon) % 1440;
  if (trueSolarTime < 0) trueSolarTime += 1440;
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const latRad = lat * DEG;
  const decRad = declination * DEG;
  const haRad = hourAngle * DEG;

  const cosZenith = clamp(
    Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad),
    -1, 1);
  const zenith = Math.acos(cosZenith) * RAD;
  let elevation = 90 - zenith;

  // Atmospheric refraction lifts the apparent sun near the horizon.
  const refraction = atmosphericRefraction(elevation);
  const apparent = elevation + refraction;

  // Azimuth, measured clockwise from north.
  //
  // The `180 -` and the sign flip for a positive hour angle are both load
  // bearing: drop either and the whole thing mirrors east for west, which
  // looks plausible at noon and is wrong every other hour of the day.
  let azimuth;
  const denom = Math.cos(latRad) * Math.sin(zenith * DEG);
  if (Math.abs(denom) > 1e-6) {
    const cosAz = clamp((Math.sin(latRad) * cosZenith - Math.sin(decRad)) / denom, -1, 1);
    azimuth = 180 - Math.acos(cosAz) * RAD;
    if (hourAngle > 0) azimuth = -azimuth;      // afternoon: mirror to the west
    azimuth = ((azimuth % 360) + 360) % 360;
  } else {
    // Directly overhead or at a pole, where azimuth is undefined.
    azimuth = lat > 0 ? 180 : 0;
  }

  return {
    azimuth,
    elevation: apparent,
    trueElevation: elevation,
    declination,
    hourAngle,
    eqTime,
    zenith,
  };
}

function atmosphericRefraction(elevationDeg) {
  if (elevationDeg > 85) return 0;
  const te = Math.tan(elevationDeg * DEG);
  let r;
  if (elevationDeg > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevationDeg > -0.575) {
    r = 1735 + elevationDeg * (-518.2 + elevationDeg * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)));
  } else r = -20.772 / te;
  return r / 3600;
}

/**
 * Sunrise and sunset as fractional UTC hours, or null when the sun does not
 * cross the horizon that day - which is the correct answer inside the polar
 * circles and matters for the places this game will happily drop you.
 */
export function sunriseSunset(date, lat, lon) {
  const noon = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
  const { declination, eqTime } = solarPosition(noon, lat, lon);
  const latRad = lat * DEG, decRad = declination * DEG;
  const cosHa = (Math.cos(90.833 * DEG) - Math.sin(latRad) * Math.sin(decRad)) /
                (Math.cos(latRad) * Math.cos(decRad));
  if (cosHa > 1) return { sunrise: null, sunset: null, polar: 'night' };
  if (cosHa < -1) return { sunrise: null, sunset: null, polar: 'day' };
  const ha = Math.acos(cosHa) * RAD;
  const sunriseMin = 720 - 4 * (lon + ha) - eqTime;
  const sunsetMin = 720 - 4 * (lon - ha) - eqTime;
  return { sunrise: sunriseMin / 60, sunset: sunsetMin / 60, polar: null };
}

/**
 * Moon position, using a low-order lunar theory. Accurate to a fraction of a
 * degree, which is far more than enough to hang a moon in the sky.
 */
export function lunarPosition(date, lat, lon) {
  const jd = julianDay(date);
  const t = julianCentury(jd);
  const L = (218.316 + 13.176396 * (jd - 2451545)) % 360;
  const M = (134.963 + 13.064993 * (jd - 2451545)) % 360;
  const F = (93.272 + 13.229350 * (jd - 2451545)) % 360;
  const lambda = (L + 6.289 * Math.sin(M * DEG)) * DEG;
  const beta = 5.128 * Math.sin(F * DEG) * DEG;
  const eps = (23.4393 - 3.563e-7 * (jd - 2451545)) * DEG;

  const ra = Math.atan2(
    Math.sin(lambda) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps),
    Math.cos(lambda));
  const dec = Math.asin(Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lambda));

  // Greenwich mean sidereal time, then the local hour angle.
  const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545)) % 360;
  const lst = ((gmst + lon) % 360) * DEG;
  const ha = lst - ra;

  const latRad = lat * DEG;
  const alt = Math.asin(Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha));
  let az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(latRad) - Math.tan(dec) * Math.cos(latRad));
  az = (az * RAD + 180) % 360;

  // Illuminated fraction, from the elongation from the sun.
  const sunM = (357.529 + 0.98560028 * (jd - 2451545)) * DEG;
  const sunL = (280.459 + 0.98564736 * (jd - 2451545)) * DEG;
  const sunLambda = sunL + (1.915 * Math.sin(sunM) + 0.020 * Math.sin(2 * sunM)) * DEG;
  const elong = Math.acos(Math.cos(beta) * Math.cos(lambda - sunLambda));
  const phase = (1 - Math.cos(elong)) / 2;

  return { azimuth: az, elevation: alt * RAD, phase };
}

/**
 * Convert azimuth/elevation to a game-space direction (+x east, +y up, -z north).
 * `out` may be any object with x/y/z, so a THREE.Vector3 works without this
 * module having to know what three.js is.
 */
export function azElToDirection(azimuthDeg, elevationDeg, out = { x: 0, y: 0, z: 0 }) {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const horizontal = Math.cos(el);
  out.x = horizontal * Math.sin(az);
  out.y = Math.sin(el);
  out.z = -horizontal * Math.cos(az);
  return out;
}
