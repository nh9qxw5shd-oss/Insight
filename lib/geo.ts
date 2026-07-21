'use client'

// ─── Route gazetteer ─────────────────────────────────────────────────────────
// Approximate coordinates for locations on and around the EMCC route (MML
// St Pancras–Sheffield, Derby/Nottingham/Lincoln, the Erewash and eastern
// branches, and the London North end). Incident locations are free text, so
// matching is by normalised name containment — "Chesterfield South Junction"
// resolves to Chesterfield's coordinates. Precision is deliberately modest
// (~street level is unnecessary): the consumer is radius bucketing at
// 10–50 miles, where a mile of error changes nothing. Locations that don't
// match any entry simply fall out of the radius tier — profiles state how
// many locations matched, so coverage is always visible.
//
// Measured coverage at introduction: 77% of incidents resolve (1,033 of
// 1,702 distinct locations); the frequent non-matches are genuinely
// non-geographic entries ("EMCC", "GTR Network", "NA", "EM Area").

export interface GeoPoint { lat: number; lon: number; label: string }

// Keys are lowercase tokens searched for INSIDE the normalised location
// string; longest key wins so "luton airport parkway" beats "luton" and
// "bedford st johns" beats "bedford".
const GAZETTEER: Record<string, GeoPoint> = {
  // London end / London North
  'st pancras':             { lat: 51.531, lon: -0.126, label: 'London St Pancras' },
  'kings cross':            { lat: 51.532, lon: -0.124, label: 'London Kings Cross' },
  'farringdon':             { lat: 51.520, lon: -0.105, label: 'Farringdon' },
  'city thameslink':        { lat: 51.514, lon: -0.103, label: 'City Thameslink' },
  'blackfriars':            { lat: 51.512, lon: -0.103, label: 'Blackfriars' },
  'london bridge':          { lat: 51.505, lon: -0.086, label: 'London Bridge' },
  'clerkenwell':            { lat: 51.524, lon: -0.113, label: 'Clerkenwell Tunnels' },
  'kentish town':           { lat: 51.550, lon: -0.140, label: 'Kentish Town' },
  'west hampstead':         { lat: 51.547, lon: -0.192, label: 'West Hampstead' },
  'cricklewood':            { lat: 51.558, lon: -0.213, label: 'Cricklewood' },
  'hendon':                 { lat: 51.583, lon: -0.226, label: 'Hendon' },
  'mill hill':              { lat: 51.613, lon: -0.249, label: 'Mill Hill Broadway' },
  'elstree':                { lat: 51.653, lon: -0.280, label: 'Elstree & Borehamwood' },
  'radlett':                { lat: 51.685, lon: -0.318, label: 'Radlett' },
  'st albans':              { lat: 51.750, lon: -0.327, label: 'St Albans City' },
  'harpenden':              { lat: 51.815, lon: -0.352, label: 'Harpenden' },
  'luton airport parkway':  { lat: 51.872, lon: -0.396, label: 'Luton Airport Parkway' },
  'luton':                  { lat: 51.882, lon: -0.414, label: 'Luton' },
  'leagrave':               { lat: 51.903, lon: -0.435, label: 'Leagrave' },
  'harlington':             { lat: 51.963, lon: -0.497, label: 'Harlington' },
  'flitwick':               { lat: 52.003, lon: -0.495, label: 'Flitwick' },
  // Bedford / Northants
  'bedford st johns':       { lat: 52.130, lon: -0.473, label: 'Bedford St Johns' },
  'bedford':                { lat: 52.136, lon: -0.480, label: 'Bedford' },
  'sharnbrook':             { lat: 52.225, lon: -0.545, label: 'Sharnbrook' },
  'irchester':              { lat: 52.275, lon: -0.635, label: 'Irchester' },
  'wellingborough':         { lat: 52.308, lon: -0.674, label: 'Wellingborough' },
  'kettering':              { lat: 52.393, lon: -0.730, label: 'Kettering' },
  'corby':                  { lat: 52.488, lon: -0.685, label: 'Corby' },
  'market harborough':      { lat: 52.476, lon: -0.925, label: 'Market Harborough' },
  // Leicestershire
  'kibworth':               { lat: 52.540, lon: -0.990, label: 'Kibworth' },
  'wigston':                { lat: 52.578, lon: -1.100, label: 'Wigston' },
  'knighton':               { lat: 52.615, lon: -1.115, label: 'Knighton' },
  'leicester':              { lat: 52.631, lon: -1.125, label: 'Leicester' },
  'syston':                 { lat: 52.700, lon: -1.080, label: 'Syston' },
  'sileby':                 { lat: 52.731, lon: -1.106, label: 'Sileby' },
  'barrow upon soar':       { lat: 52.750, lon: -1.145, label: 'Barrow upon Soar' },
  'barrow on soar':         { lat: 52.750, lon: -1.145, label: 'Barrow upon Soar' },
  'loughborough':           { lat: 52.769, lon: -1.204, label: 'Loughborough' },
  'melton mowbray':         { lat: 52.762, lon: -0.885, label: 'Melton Mowbray' },
  'oakham':                 { lat: 52.668, lon: -0.731, label: 'Oakham' },
  'stamford':               { lat: 52.648, lon: -0.480, label: 'Stamford' },
  // Trent / Nottingham / Derby
  'east midlands parkway':  { lat: 52.862, lon: -1.263, label: 'East Midlands Parkway' },
  'trent':                  { lat: 52.880, lon: -1.290, label: 'Trent Junctions' },
  'toton':                  { lat: 52.900, lon: -1.270, label: 'Toton' },
  'long eaton':             { lat: 52.885, lon: -1.276, label: 'Long Eaton' },
  'attenborough':           { lat: 52.906, lon: -1.230, label: 'Attenborough' },
  'beeston':                { lat: 52.921, lon: -1.207, label: 'Beeston' },
  'nottingham':             { lat: 52.947, lon: -1.146, label: 'Nottingham' },
  'netherfield':            { lat: 52.963, lon: -1.084, label: 'Netherfield' },
  'carlton':                { lat: 52.965, lon: -1.083, label: 'Carlton' },
  'ilkeston':               { lat: 52.980, lon: -1.305, label: 'Ilkeston' },
  'langley mill':           { lat: 53.005, lon: -1.325, label: 'Langley Mill' },
  'alfreton':               { lat: 53.100, lon: -1.370, label: 'Alfreton' },
  'kirkby in ashfield':     { lat: 53.098, lon: -1.245, label: 'Kirkby-in-Ashfield' },
  'kirkby-in-ashfield':     { lat: 53.098, lon: -1.245, label: 'Kirkby-in-Ashfield' },
  'mansfield woodhouse':    { lat: 53.163, lon: -1.193, label: 'Mansfield Woodhouse' },
  'mansfield':              { lat: 53.145, lon: -1.198, label: 'Mansfield' },
  'shirebrook':             { lat: 53.203, lon: -1.220, label: 'Shirebrook' },
  'worksop':                { lat: 53.310, lon: -1.120, label: 'Worksop' },
  'spondon':                { lat: 52.913, lon: -1.404, label: 'Spondon' },
  'derby':                  { lat: 52.916, lon: -1.464, label: 'Derby' },
  'duffield':               { lat: 52.987, lon: -1.489, label: 'Duffield' },
  'belper':                 { lat: 53.024, lon: -1.482, label: 'Belper' },
  'ambergate':              { lat: 53.061, lon: -1.481, label: 'Ambergate' },
  'whatstandwell':          { lat: 53.083, lon: -1.503, label: 'Whatstandwell' },
  'cromford':               { lat: 53.112, lon: -1.548, label: 'Cromford' },
  'matlock':                { lat: 53.138, lon: -1.552, label: 'Matlock' },
  'willington':             { lat: 52.855, lon: -1.560, label: 'Willington' },
  'burton':                 { lat: 52.805, lon: -1.643, label: 'Burton-on-Trent' },
  'tutbury':                { lat: 52.865, lon: -1.685, label: 'Tutbury & Hatton' },
  'uttoxeter':              { lat: 52.895, lon: -1.855, label: 'Uttoxeter' },
  // North end
  'clay cross':             { lat: 53.163, lon: -1.412, label: 'Clay Cross' },
  'chesterfield':           { lat: 53.238, lon: -1.420, label: 'Chesterfield' },
  'dronfield':              { lat: 53.302, lon: -1.467, label: 'Dronfield' },
  'dore':                   { lat: 53.327, lon: -1.516, label: 'Dore & Totley' },
  'sheffield':              { lat: 53.378, lon: -1.462, label: 'Sheffield' },
  // Lincoln / east
  'newark north gate':      { lat: 53.085, lon: -0.810, label: 'Newark North Gate' },
  'newark castle':          { lat: 53.078, lon: -0.816, label: 'Newark Castle' },
  'newark':                 { lat: 53.080, lon: -0.813, label: 'Newark' },
  'collingham':             { lat: 53.142, lon: -0.760, label: 'Collingham' },
  'swinderby':              { lat: 53.168, lon: -0.700, label: 'Swinderby' },
  'hykeham':                { lat: 53.201, lon: -0.606, label: 'Hykeham' },
  'lincoln':                { lat: 53.226, lon: -0.540, label: 'Lincoln' },
  'saxilby':                { lat: 53.268, lon: -0.660, label: 'Saxilby' },
  'gainsborough':           { lat: 53.400, lon: -0.770, label: 'Gainsborough' },
  'sleaford':               { lat: 52.995, lon: -0.410, label: 'Sleaford' },
  'boston':                 { lat: 52.978, lon: -0.028, label: 'Boston' },
  'skegness':               { lat: 53.143, lon: 0.335, label: 'Skegness' },
  'grantham':               { lat: 52.906, lon: -0.642, label: 'Grantham' },
  'spalding':               { lat: 52.788, lon: -0.152, label: 'Spalding' },
  'peterborough':           { lat: 52.575, lon: -0.250, label: 'Peterborough' },
  'grimsby':                { lat: 53.566, lon: -0.090, label: 'Grimsby' },
  'cleethorpes':            { lat: 53.561, lon: -0.030, label: 'Cleethorpes' },
  'barnetby':               { lat: 53.579, lon: -0.410, label: 'Barnetby' },
  'scunthorpe':             { lat: 53.586, lon: -0.650, label: 'Scunthorpe' },
  // Junctions, depots and secondary stations that appear frequently in logs
  'radford':                { lat: 52.965, lon: -1.175, label: 'Radford Junction' },
  'harrowden':              { lat: 52.320, lon: -0.690, label: 'Harrowden Junction' },
  'kilby bridge':           { lat: 52.560, lon: -1.090, label: 'Kilby Bridge' },
  'boultham':               { lat: 53.215, lon: -0.560, label: 'Boultham' },
  'brent cross':            { lat: 51.576, lon: -0.220, label: 'Brent Cross West' },
  'stenson':                { lat: 52.870, lon: -1.510, label: 'Stenson Junction' },
  'bulwell':                { lat: 53.001, lon: -1.197, label: 'Bulwell' },
  'longton':                { lat: 52.988, lon: -2.135, label: 'Longton' },
  'bingham':                { lat: 52.952, lon: -0.951, label: 'Bingham' },
  'peartree':               { lat: 52.895, lon: -1.475, label: 'Peartree' },
  'newstead':               { lat: 53.075, lon: -1.225, label: 'Newstead' },
  'trowell':                { lat: 52.955, lon: -1.290, label: 'Trowell Junction' },
  'meadow lane':            { lat: 52.945, lon: -1.135, label: 'Meadow Lane' },
  'hucknall':               { lat: 53.038, lon: -1.200, label: 'Hucknall' },
  'sutton parkway':         { lat: 53.117, lon: -1.245, label: 'Sutton Parkway' },
  'thurgarton':             { lat: 53.030, lon: -0.960, label: 'Thurgarton' },
  'lowdham':                { lat: 53.010, lon: -0.995, label: 'Lowdham' },
  'burton joyce':           { lat: 52.987, lon: -1.030, label: 'Burton Joyce' },
  'fiskerton':              { lat: 53.055, lon: -0.905, label: 'Fiskerton' },
  'rolleston':              { lat: 53.060, lon: -0.895, label: 'Rolleston' },
  'bleasby':                { lat: 53.045, lon: -0.935, label: 'Bleasby' },
  'gedling':                { lat: 52.975, lon: -1.080, label: 'Gedling' },
  'colwick':                { lat: 52.945, lon: -1.070, label: 'Colwick' },
  'ruddington':             { lat: 52.892, lon: -1.130, label: 'Ruddington' },
  'sutton bonington':       { lat: 52.830, lon: -1.255, label: 'Sutton Bonington' },
  'sutton bonnington':      { lat: 52.830, lon: -1.255, label: 'Sutton Bonington' },
  'kegworth':               { lat: 52.833, lon: -1.280, label: 'Kegworth' },
  'ratcliffe':              { lat: 52.865, lon: -1.255, label: 'Ratcliffe-on-Soar' },
  'etches park':            { lat: 52.905, lon: -1.455, label: 'Derby Etches Park' },
  'eastcroft':              { lat: 52.945, lon: -1.140, label: 'Nottingham Eastcroft' },
  'desborough':             { lat: 52.440, lon: -0.815, label: 'Desborough' },
  'finedon':                { lat: 52.340, lon: -0.660, label: 'Finedon' },
  'wichnor':                { lat: 52.752, lon: -1.720, label: 'Wichnor Junction' },
  'westhouses':             { lat: 53.110, lon: -1.350, label: 'Westhouses' },
  'sawley':                 { lat: 52.870, lon: -1.300, label: 'Sawley' },
  'swineshead':             { lat: 52.943, lon: -0.240, label: 'Swineshead' },
  'hubberts bridge':        { lat: 52.965, lon: -0.070, label: 'Hubberts Bridge' },
  'wainfleet':              { lat: 53.105, lon: 0.235, label: 'Wainfleet' },
  'heckington':             { lat: 52.980, lon: -0.295, label: 'Heckington' },
  'ancaster':               { lat: 52.985, lon: -0.535, label: 'Ancaster' },
  'rauceby':                { lat: 52.995, lon: -0.435, label: 'Rauceby' },
  'metheringham':           { lat: 53.135, lon: -0.400, label: 'Metheringham' },
  'ruskington':             { lat: 53.045, lon: -0.385, label: 'Ruskington' },
  'bottesford':             { lat: 52.945, lon: -0.800, label: 'Bottesford' },
  'aslockton':              { lat: 52.950, lon: -0.900, label: 'Aslockton' },
  'radcliffe':              { lat: 52.945, lon: -1.035, label: 'Radcliffe-on-Trent' },
  'wickenby':               { lat: 53.320, lon: -0.395, label: 'Wickenby' },
  'langworth':              { lat: 53.265, lon: -0.460, label: 'Langworth' },
  'market rasen':           { lat: 53.387, lon: -0.335, label: 'Market Rasen' },
  'holton le moor':         { lat: 53.460, lon: -0.310, label: 'Holton le Moor' },
}

// Longest keys first so the most specific name wins.
const KEYS = Object.keys(GAZETTEER).sort((a, b) => b.length - a.length)

function normalise(location: string): string {
  return location
    .toLowerCase()
    .replace(/\s*-\s*\[[^\]]*\]\s*$/, '')   // strip trailing "- [XXX]" codes
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const matchCache = new Map<string, GeoPoint | null>()

// Resolve a free-text incident location to gazetteer coordinates, or null.
export function geocodeLocation(location: string | null | undefined): GeoPoint | null {
  if (!location) return null
  const cached = matchCache.get(location)
  if (cached !== undefined) return cached
  const n = ` ${normalise(location)} `
  let hit: GeoPoint | null = null
  for (const key of KEYS) {
    // Word-boundary containment: " derby " inside " derby station "
    if (n.includes(` ${key} `) || n.trim() === key) { hit = GAZETTEER[key]; break }
  }
  matchCache.set(location, hit)
  return hit
}

// Great-circle distance in statute miles.
export function milesBetween(a: GeoPoint, b: GeoPoint): number {
  const R = 3958.8
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
