// Run with: npm test   (node --test, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../js/venue-category.js");

const club = (name, types = [], opts) => V.classifyClub({ name, types }, opts).isClub;
const label = (name, types = [], extra = {}) => V.getVenueCategory({ name, types, ...extra });

test("normaliseName folds punctuation, apostrophes and accents", () => {
  assert.equal(V.normaliseName("R.S.L. Club"), "rsl club");
  assert.equal(V.normaliseName("Workers’ Club"), "workers club");
  assert.equal(V.normaliseName("Ex-Services  Club"), "ex services club");
  assert.equal(V.normaliseName("Café Club"), "cafe club");
  assert.equal(V.normaliseName(null), "");
});

test("getPrimaryCategory keeps its existing behaviour", () => {
  assert.equal(V.getPrimaryCategory(["bar", "restaurant"]), "Pub/Bar");
  assert.equal(V.getPrimaryCategory(["pub"]), "Pub/Bar");
  assert.equal(V.getPrimaryCategory(["night_club"]), "Pub/Bar");
  assert.equal(V.getPrimaryCategory(["cafe", "restaurant"]), "Cafe");
  assert.equal(V.getPrimaryCategory(["restaurant"]), "Restaurant");
  assert.equal(V.getPrimaryCategory([]), "Other");
  assert.equal(V.getPrimaryCategory(), "Other");
});

test("Newcastle NSW clubs that the old hints missed are found in the club lane", () => {
  const names = [
    "Toronto Diggers", "Wallsend Diggers", "Wests Cardiff", "Wests City", "Wests Mayfield",
    "Wests New Lambton", "MEX Club", "Club Kotara", "Souths Merewether",
    "Lake Macquarie Yacht Club", "Toronto Yacht Club", "Newcastle Surf Life Saving Club",
  ];
  for (const name of names) {
    assert.ok(club(name, ["sports_club", "point_of_interest", "establishment"], { clubLane: true }), name);
  }
});

test("named clubs are clubs whatever their types", () => {
  const names = [
    "Toronto Diggers", "Wests Cardiff", "Souths Merewether", "Lake Macquarie Yacht Club",
    "Newcastle Surf Life Saving Club", "Mayfield West Bowling Club", "The Entrance Leagues Club",
    "Merewether Bowlo", "Cardiff RSL", "Belmont 16s Sailing Club", "Charlestown Golf Club",
    "Adamstown R.S.L. Club", "Kurri Kurri Ex-Services Club", "Cessnock Workers' Club",
    "Bar Beach Bowling Club", "Merewether SLSC",
  ];
  for (const name of names) assert.ok(club(name, ["establishment"]), name);
});

test("bowling and RSL clubs from the bar/pub search are labelled Club, not Pub/Bar", () => {
  assert.equal(label("Hamilton North Bowling Club", ["bar", "point_of_interest"]), "Club");
  assert.equal(label("Cardiff RSL", ["bar", "restaurant"]), "Club");
  assert.equal(label("Wests City", ["restaurant"]), "Club");
  assert.equal(label("MEX Club", ["bar", "restaurant"]), "Club");
});

test("generic 'club' needs a hospitality or club type outside the club lane", () => {
  assert.equal(club("Club Kotara", []), false);
  assert.equal(club("Club Kotara", ["establishment"]), false);
  assert.equal(club("Club Kotara", ["bar"]), true);
  assert.equal(club("Club Kotara", ["sports_club"]), true);
  assert.equal(club("Club Kotara", [], { clubLane: true }), true);
  assert.equal(V.classifyClub({ name: "MEX Club", types: ["restaurant"] }).strength, "generic");
});

test("pubs, bars and other 'clubs' are not licensed clubs", () => {
  const notClubs = [
    ["The Gravediggers", ["bar", "pub"]],
    ["John Kavanagh The Gravediggers", ["pub"]],
    ["Stella Cocktail Club", ["bar"]],
    ["Fitzrovia Comedy Club", ["bar"]],
    ["The Breakfast Club Angel", ["restaurant", "bar"]],
    ["Club Quarters Hotel Trafalgar Square", ["lodging", "restaurant"]],
    ["Coppa Club Marylebone", ["restaurant", "bar"]],
    ["Cosy Club", ["restaurant", "bar"]],
    ["Flight Club Shoreditch", ["bar"]],
    ["Carwash Nightclub", ["night_club", "bar"]],
    ["Luxe Club", ["night_club"]],
    ["TSQ Club", ["night_club", "bar"]],
    ["Ronnie Scott's Jazz Club", ["bar"]],
    ["Bernie's Supper Club & Cinema", ["restaurant"]],
    ["Locke Coffee Club", ["cafe", "bar"]],
    ["Club Kitchen", ["restaurant"]],
    ["Westside Hotel", ["bar", "pub"]],
    ["Diggers Rest Hotel", ["bar", "pub"]],
    ["Souths Tavern", ["bar"]],
    ["The Clubhouse", ["bar"]],
    ["Rouse Hill Lawn Tennis", ["establishment"]],
  ];
  for (const [name, types] of notClubs) {
    assert.equal(club(name, types), false, name);
    assert.equal(club(name, types, { clubLane: true }), false, `${name} (club lane)`);
  }
  assert.equal(label("The Gravediggers", ["bar", "pub"]), "Pub/Bar");
  assert.equal(label("Westside Hotel", ["bar", "pub"]), "Pub/Bar");
  assert.equal(label("Coppa Club Marylebone", ["restaurant"]), "Restaurant");
});

test("the club lane drops sports results that are not clubs", () => {
  assert.equal(club("Newcastle Basketball Stadium", ["stadium"], { clubLane: true }), false);
  assert.equal(club("Anytime Fitness Kotara", ["gym"], { clubLane: true }), false);
  assert.equal(club("Kotara Health Club", ["gym"], { clubLane: true }), false);
});

test("club-lane results from the Newcastle capture (November 2026)", () => {
  const lane = (name, types) => club(name, types.split(","), { clubLane: true });
  const sc = "sports_club,association_or_organization,point_of_interest,establishment";
  assert.equal(lane("Club Merewether", sc), true);
  assert.equal(lane("Bar Beach Bowling & Sporting Club\u200e", sc), true);
  assert.equal(lane("Beach Life at Newcastle SLSC", "sports_club,live_music_venue,event_venue,restaurant,food"), true);
  assert.equal(lane("Wests City", "pizza_restaurant,bistro,cafe,sports_club,bar,event_venue,restaurant"), true);
  assert.equal(lane("Newcastle Hill Tennis Club", sc), false);
  assert.equal(lane("Sports Parc", "sports_complex,sports_activity_location"), false);
  assert.equal(lane("BFT Newcastle | Group Fitness & Strength Training Gym", "gym,fitness_center"), false);
  assert.equal(lane("Stockton Swimming Centre", "swimming_pool,sports_club"), false);
  // Dublin and London captures: gyms called "… Club" stay off the map.
  assert.equal(lane("West Wood Club", "gym,fitness_center,swimming_pool,spa,sports_club,association_or_organization,health"), false);
  assert.equal(lane("Southbank Club", "fitness_center,gym,sports_club,association_or_organization,health"), false);
  assert.equal(lane("Royal Ocean Racing Club, Ltd", "sports_club,association_or_organization"), true);
  assert.equal(lane("S & V Members Club x AIJ", "sports_bar,bar"), true);
  // A sport word does not block a club that has a bar or bistro.
  assert.equal(club("Pembroke Wanderers Hockey Club", ["sports_club", "bar"]), true);
});

test("Sunny enrichment categories mark clubs when supplied", () => {
  assert.equal(label("Somewhere Green", [], { categories: ["Lawn bowls club"] }), "Club");
  assert.equal(label("The Walbrook", [], { categories: ["Club", "Social club"] }), "Club");
  assert.equal(label("Union Jack", ["restaurant"], { categories: ["Club", "Event venue", "Hotel"] }), "Club");
  assert.equal(label("Pembroke Wanderers", ["bar"], { categories: ["Hockey club", "Sports bar", "Sports club"] }), "Club");
  assert.equal(label("TSQ", ["night_club", "bar"], { categories: ["Night club", "Bar"] }), "Pub/Bar");
  assert.equal(label("Angel", ["bar"], { categories: ["Comedy club", "Bar", "Pub"] }), "Pub/Bar");
  assert.equal(label("The Clubhouse Marylebone", ["bar"], { categories: ["Club", "Cocktail bar", "Live music venue"] }), "Pub/Bar");
  assert.equal(label("Plain Bar", ["bar"], { categories: [] }), "Pub/Bar");
  // A nightclub category overrides a "… Club" name even when Google types say only "bar".
  assert.equal(label("Luxe Club", ["bar"], { categories: ["Night club"] }), "Pub/Bar");
  assert.equal(label("The Speakeasy Club", ["bar"]), "Pub/Bar");
  assert.equal(label("Finsbury Square Garden Bar", ["bar"], { categories: ["Bar", "Lawn bowls club", "Pub"] }), "Pub/Bar");
});

test("types may be a comma-separated string, as stored on venue tags", () => {
  assert.equal(label("MEX Club", "bar,restaurant"), "Club");
  assert.equal(label("The Gravediggers", "bar,pub"), "Pub/Bar");
});

test("the club lane still makes one text query", () => {
  assert.deepEqual(V.CLUB_TEXT_QUERIES, ["sports club"]);
});
