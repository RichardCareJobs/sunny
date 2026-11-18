/*
  Sunny — venue-category.js
  Pure, dependency-free venue labelling: the card's category ("Pub/Bar", "Cafe",
  "Restaurant", "Club", "Other") and the licensed-club rules used by map
  discovery, the crawl builder and search. Loads as a classic <script> (exposes
  window.SunnyVenueCategory) and via require() in Node for the tests.

  Club rules, strongest first:
    1. Strong name hints (bowling club, RSL, leagues, yacht club …): always a club.
    2. Weak name hints (diggers, wests, souths …): a club unless the name also
       reads like a pub ("Diggers Rest Hotel").
    3. Sunny's own enrichment categories, when supplied ("Lawn bowls club" …).
    4. The word "club" with no negative term ("Comedy Club", "Cocktail Club",
       "The Breakfast Club" …). Outside the club text-search lane it also needs a
       hospitality or sports-club type, so a bare "X Club" never turns into a pin.
  Names are matched on whole words, so "Gravediggers" is not "diggers".
*/
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SunnyVenueCategory = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The club lane's Places text searches. One call per map load or crawl.
  const CLUB_TEXT_QUERIES = ["sports club"];

  const STRONG_CLUB_HINTS = [
    "bowling club", "bowls club", "bowlo", "lawn bowls",
    "rsl", "returned services", "ex services", "services club", "memorial club",
    "leagues", "workers club", "sports club",
    "yacht club", "sailing club", "surf club", "surf life saving", "slsc", "golf club",
  ];
  // Common in club names but also in pub names, so a pub word cancels them.
  const WEAK_CLUB_HINTS = ["diggers", "wests", "souths", "norths", "easts"];
  const PUB_NAME_WORDS = ["hotel", "tavern", "inn", "pub", "arms", "public house"];

  // Stops the generic "club" rule. Strong and weak hints are not affected.
  const CLUB_NAME_NEGATIVES = [
    "night", "nightclub", "speakeasy", "comedy", "cocktail", "jazz", "blues", "cabaret", "strip",
    "gentlemen", "gentlemens", "adult", "breakfast", "supper", "coffee", "wine club",
    "book", "chess", "board game", "dart", "darts", "flight club", "fitness", "gym",
    "health", "hotel", "quarters", "kitchen", "coppa club", "cosy club",
  ];
  // Sports with clubs that are rarely licensed venues. They stop the generic "club"
  // rule only when the place has no hospitality type, so a hockey club with a bar
  // still counts but a tennis club with courts only does not.
  const SPORT_ONLY_NEGATIVES = [
    "tennis", "hockey", "football", "soccer", "cricket", "netball", "basketball",
    "squash", "swimming", "swim", "athletics", "cycling", "running", "rowing",
    "pony", "kennel", "dog", "gymnastics", "martial arts", "karate", "boxing",
  ];
  // Types that give a "… Club" name a hospitality or licensed-club context.
  // Fitness-club types. Like SPORT_ONLY_NEGATIVES, they stop the generic rule only
  // without a hospitality type ("West Wood Club", "Southbank Club" are gyms).
  const FITNESS_TYPES = ["gym", "fitness_center", "spa", "yoga_studio", "sauna"];
  const HOSPITALITY_TYPES = ["bar", "pub", "restaurant", "sports_bar", "bar_and_grill", "wine_bar", "bistro"];
  const CLUB_CONTEXT_TYPES = HOSPITALITY_TYPES.concat(["sports_club", "golf_course"]);

  // Enrichment (Google Maps) category labels, lower-cased.
  const CLUB_CATEGORIES = new Set([
    "social club", "sports club", "lawn bowls club", "bowling club", "bowls club",
    "golf club", "country club", "yacht club", "sailing club", "surf life saving club",
    "rsl club", "returned services league club", "leagues club", "workers club",
    "community club", "veterans organization", "veterans organisation",
  ]);
  // A plain "Club" category counts only without one of these alongside it.
  const NON_CLUB_CATEGORY_WORDS = ["night club", "nightclub", "comedy", "jazz", "blues",
    "disco", "cabaret", "adult", "karaoke", "cocktail bar"];

  function getPrimaryCategory(types) {
    const list = Array.isArray(types) ? types : [];
    if (list.includes("bar") || list.includes("pub") || list.includes("night_club")) return "Pub/Bar";
    if (list.includes("cafe")) return "Cafe";
    if (list.includes("restaurant")) return "Restaurant";
    return "Other";
  }

  // Lower-case, fold accents and apostrophes, turn punctuation into spaces.
  // "R.S.L." -> "rsl", "Workers' Club" -> "workers club", "Ex-Services" -> "ex services".
  function normaliseName(name) {
    return String(name || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/['’`.]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  function hasPhrase(normalised, phrase) {
    return (" " + normalised + " ").includes(" " + phrase + " ");
  }
  function findPhrase(normalised, phrases) {
    return phrases.find((phrase) => hasPhrase(normalised, phrase)) || null;
  }
  function typeList(input) {
    const raw = Array.isArray(input && input.types) ? input.types
      : (typeof (input && input.types) === "string" ? input.types.split(",") : []);
    const list = raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const primary = input && input.primaryType ? String(input.primaryType).toLowerCase() : "";
    if (primary && !list.includes(primary)) list.push(primary);
    return list;
  }
  function categoryList(input) {
    const raw = Array.isArray(input && input.categories) ? input.categories : [];
    return raw.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  }

  function classifyClubCategories(categories) {
    if (!categories.length) return null;
    const hit = categories.find((c) => CLUB_CATEGORIES.has(c));
    if (hit) return hit;
    if (categories.includes("club")) {
      const clash = categories.some((c) => NON_CLUB_CATEGORY_WORDS.some((w) => c.includes(w)));
      if (!clash) return "club";
    }
    return null;
  }

  // -> { isClub, reason, strength: "strong"|"weak"|"category"|"generic"|null }
  function classifyClub(input, options) {
    const clubLane = !!(options && options.clubLane);
    const name = normaliseName(input && (input.displayName || input.name || input.mainText));
    const types = typeList(input);

    const strong = findPhrase(name, STRONG_CLUB_HINTS);
    if (strong) return { isClub: true, reason: "name:" + strong, strength: "strong" };

    const weak = findPhrase(name, WEAK_CLUB_HINTS);
    if (weak && !findPhrase(name, PUB_NAME_WORDS)) {
      return { isClub: true, reason: "name:" + weak, strength: "weak" };
    }

    // A club category next to a pub or bar name is usually a side activity
    // ("Finsbury Square Garden Bar" lists "Lawn bowls club"), so the name wins.
    const pubName = findPhrase(name, PUB_NAME_WORDS.concat(["bar"]));
    const category = pubName ? null : classifyClubCategories(categoryList(input));
    if (category) return { isClub: true, reason: "category:" + category, strength: "category" };

    if (hasPhrase(name, "club")) {
      const negative = findPhrase(name, CLUB_NAME_NEGATIVES);
      if (negative) return { isClub: false, reason: "negative:" + negative, strength: null };
      if (types.includes("night_club")) return { isClub: false, reason: "type:night_club", strength: null };
      const categories = categoryList(input);
      if (categories.some((c) => NON_CLUB_CATEGORY_WORDS.some((w) => c.includes(w)))) {
        return { isClub: false, reason: "category:not a licensed club", strength: null };
      }
      const hospitality = types.some((t) => HOSPITALITY_TYPES.includes(t));
      const sport = hospitality ? null : findPhrase(name, SPORT_ONLY_NEGATIVES);
      if (sport) return { isClub: false, reason: "negative:" + sport + " (no hospitality type)", strength: null };
      const fitness = hospitality ? null : types.find((t) => FITNESS_TYPES.includes(t));
      if (fitness) return { isClub: false, reason: "type:" + fitness + " (no hospitality type)", strength: null };
      if (clubLane || types.some((t) => CLUB_CONTEXT_TYPES.includes(t))) {
        return { isClub: true, reason: clubLane ? "name:club (club lane)" : "name:club+type", strength: "generic" };
      }
      return { isClub: false, reason: "name:club without context", strength: null };
    }
    return { isClub: false, reason: weak ? "weak-hint cancelled by pub name" : "no club signal", strength: null };
  }

  function isClub(input, options) {
    return classifyClub(input, options).isClub;
  }

  // Card label for a venue. `input` takes { name, types, primaryType, categories }.
  function getVenueCategory(input, options) {
    if (isClub(input, options)) return "Club";
    const raw = input && input.types;
    return getPrimaryCategory(Array.isArray(raw) ? raw : (typeof raw === "string" ? raw.split(",") : []));
  }

  return {
    CLUB_TEXT_QUERIES, STRONG_CLUB_HINTS, WEAK_CLUB_HINTS, CLUB_NAME_NEGATIVES, SPORT_ONLY_NEGATIVES,
    FITNESS_TYPES, HOSPITALITY_TYPES, CLUB_CONTEXT_TYPES,
    normaliseName, getPrimaryCategory, classifyClub, isClub, getVenueCategory,
  };
});
