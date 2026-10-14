// Cloudflare Pages Function: GET /api/reviews
//
// Fetches GH1 Construction's Google rating + reviews via the Places API (New)
// and returns them as JSON. Results are cached at the edge so the Places API
// is only hit a few times a day, not on every page view.
//
// Requires a Cloudflare Pages environment variable (set in the dashboard,
// never committed to the repo): GOOGLE_PLACES_API_KEY
//
// The key must be restricted (in Google Cloud Console) to:
//   - API restriction: Places API (New) only
// (Application/website restriction is intentionally NOT used — this key is
// called server-side from Cloudflare, not from the visitor's browser, so
// there's no real HTTP referrer to check.)
//
// Always returns HTTP 200 with a JSON body, even when no reviews are found
// yet. Non-2xx statuses get intercepted by Cloudflare and replaced with its
// own branded error page, which would hide our actual JSON — easier to just
// let the front-end check `reviews.length` instead of the status code.

// GH1 is a service-area listing with a hidden street address, so searching by
// street address misses it. Search by name, biased toward Chicago; the name /
// phone safety check below is what guarantees we only ever accept GH1.
const BUSINESS_QUERY = 'GH1 Construction';
// Place ID derived from GH1's Google Maps listing (feature ID
// 0xa9431b8c7468f579:0x8882b56991112da6). Not a secret. Tried first; if Google
// doesn't serve it, we fall back to the name search below.
const KNOWN_PLACE_ID = 'ChIJefVodIwbQ6kRpi0RkWm1gog';
const SEARCH_BIAS = { circle: { center: { latitude: 41.8781, longitude: -87.6298 }, radius: 50000 } };
const SUCCESS_CACHE_SECONDS = 6 * 60 * 60; // 6 hours — real review data changes rarely
const EMPTY_CACHE_SECONDS = 15 * 60; // 15 minutes — so a real match isn't hidden for long once Google's index catches up
// Bump this whenever the resolution/validation logic changes, so a bad
// cached response (e.g. the wrong business) can't outlive a fix — it
// changes the cache key, so old entries are simply never matched again.
const CACHE_VERSION = 'v5';

export async function onRequestGet(context) {
  const { env, request } = context;
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('v', CACHE_VERSION);
  const cacheKey = new Request(cacheUrl.toString(), request);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.GOOGLE_PLACES_API_KEY) {
    return emptyResponse(context, cacheKey, 'Reviews are not configured yet.');
  }

  try {
    let details = null;
    let failure = null;

    // 1) Known Place ID, 2) name search. Either way the GH1 check below decides.
    const candidates = [];
    if (KNOWN_PLACE_ID) candidates.push(['known Place ID', async () => KNOWN_PLACE_ID]);
    candidates.push(['name search', async () => {
      const r = await resolvePlaceId(env.GOOGLE_PLACES_API_KEY);
      if (!r.id) throw new Error(r.reason);
      return r.id;
    }]);

    for (const [label, getId] of candidates) {
      try {
        const candidate = await fetchPlaceDetails(await getId(), env.GOOGLE_PLACES_API_KEY);
        // Safety check, independent of the search's own check — never serve
        // another business's real reviews under GH1's name.
        const name = (candidate.displayName && candidate.displayName.text || '').toLowerCase();
        const phone = candidate.nationalPhoneNumber || '';
        if (name.indexOf('gh1') === -1 && phone.indexOf('405-5213') === -1) {
          failure = (failure ? failure + ' ' : '') + label + ': resolved place did not match GH1 Construction.';
          continue;
        }
        details = candidate;
        break;
      } catch (err) {
        failure = (failure ? failure + ' ' : '') + label + ': ' + err.message;
      }
    }

    if (!details) {
      return emptyResponse(context, cacheKey, failure || 'Could not locate the business listing.');
    }

    const payload = {
      rating: details.rating || null,
      reviewCount: details.userRatingCount || 0,
      reviews: (details.reviews || []).map((r) => ({
        name: r.authorAttribution?.displayName || 'Google user',
        photoUrl: r.authorAttribution?.photoUri || null,
        rating: r.rating || 0,
        text: r.text?.text || r.originalText?.text || '',
        relativeTime: r.relativePublishTimeDescription || '',
        publishTime: r.publishTime || null,
      })),
      fetchedAt: new Date().toISOString(),
    };

    const response = jsonResponse(payload, 200, SUCCESS_CACHE_SECONDS);
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return emptyResponse(context, cacheKey, 'Unable to fetch reviews right now: ' + err.message);
  }
}

function emptyResponse(context, cacheKey, reason) {
  const response = jsonResponse({ reviews: [], reason }, 200, EMPTY_CACHE_SECONDS);
  context.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

async function resolvePlaceId(apiKey) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.nationalPhoneNumber',
    },
    body: JSON.stringify({ textQuery: BUSINESS_QUERY, locationBias: SEARCH_BIAS }),
  });
  if (!res.ok) return { id: null, reason: 'Google Places search returned HTTP ' + res.status + '.' };
  const data = await res.json();
  if (!data.places || !data.places.length) {
    return { id: null, reason: 'Google Places search returned no results.' };
  }

  // Safety check: Text Search can return unrelated nearby businesses for a
  // brand-new, address-hidden listing like this one. Never trust places[0]
  // blindly — only accept a result whose name or phone number actually
  // matches GH1, otherwise it's safer to show nothing than someone else's
  // real reviews under GH1's name.
  const match = data.places.find((p) => {
    const name = (p.displayName && p.displayName.text || '').toLowerCase();
    const phone = p.nationalPhoneNumber || '';
    return name.indexOf('gh1') !== -1 || phone.indexOf('405-5213') !== -1;
  });
  if (!match) {
    return { id: null, reason: 'Google returned ' + data.places.length + ' result(s) but none matched GH1 Construction.' };
  }
  return { id: match.id, reason: null };
}

async function fetchPlaceDetails(placeId, apiKey) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'displayName,nationalPhoneNumber,rating,userRatingCount,reviews',
    },
  });
  if (!res.ok) throw new Error('Place Details request failed (HTTP ' + res.status + ')');
  return res.json();
}

function jsonResponse(data, status, cacheSeconds) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheSeconds) headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(data), { status, headers });
}
