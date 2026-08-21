/**
 * The eight approved product ideas.
 *
 * Titles and descriptions come from the supplied Product Ideas PDF. Everything
 * else — target user, minimum core flow, expected entities, AI opportunity,
 * allowed scope, unsafe interpretations — is our extension, because the source
 * descriptions are one or two sentences and cannot drive automated testing
 * (see docs/reference-analysis.md §3).
 *
 * `minimumCoreFlow` is the most important field: it is what the test planner
 * uses to decide what a compliant implementation must be able to do, and it is
 * checked against the team's own declared must-have workflow.
 *
 * All of this is admin-editable per cohort (ADR-013).
 */

export interface IdeaSeed {
  title: string;
  slug: string;
  description: string;
  targetUser: string;
  expectedUseCase: string;
  minimumCoreFlow: string[];
  expectedEntities: string[];
  aiOpportunity: string;
  allowedScope: string;
  unsafeInterpretations: string;
  displayOrder: number;
}

export const IDEA_SEEDS: readonly IdeaSeed[] = [
  {
    title: 'Recipe Sharing App',
    slug: 'recipe-sharing-app',
    description:
      'An app where users can post and browse simple recipes, with a public feed and user-specific saved recipes.',
    targetUser: 'Home cooks who want to keep and share simple everyday recipes.',
    expectedUseCase:
      'A user browses a public feed of recipes, opens one, saves it to their own collection, and adds a recipe of their own.',
    minimumCoreFlow: [
      'View a public feed of recipes without needing to set anything up',
      'Open a single recipe and see its ingredients and steps',
      'Create a new recipe with a title, ingredients and steps',
      'Save or bookmark a recipe to a personal collection',
      'See the saved recipe again after a page reload',
    ],
    expectedEntities: ['Recipe', 'Ingredient', 'SavedRecipe', 'User'],
    aiOpportunity:
      'Generate a recipe from a list of available ingredients, suggest substitutions, or scale quantities for a different number of servings.',
    allowedScope:
      'Recipe creation, browsing, search, saving, tagging, and simple AI assistance around ingredients or scaling.',
    unsafeInterpretations:
      'No medical, allergy-safety or nutritional-health claims presented as authoritative advice. No scraping of paywalled recipe sites. No storage of real personal dietary or health records.',
    displayOrder: 1,
  },
  {
    title: 'Fitness Goal Tracker',
    slug: 'fitness-goal-tracker',
    description:
      'An app where users set fitness goals (e.g. run 5km) and log progress with a simple dashboard.',
    targetUser: 'People working towards a specific, measurable fitness goal on their own.',
    expectedUseCase:
      'A user sets a goal, logs several progress entries against it, and sees how close they are on a dashboard.',
    minimumCoreFlow: [
      'Create a goal with a target and a unit of measurement',
      'Log a progress entry against that goal',
      'See progress reflected on a dashboard or summary view',
      'Edit or delete a progress entry',
      'See logged progress persist after a page reload',
    ],
    expectedEntities: ['Goal', 'ProgressEntry', 'User'],
    aiOpportunity:
      'Break a large goal into a weekly plan, interpret logged progress in plain language, or suggest a realistic next target from actual history.',
    allowedScope:
      'Goal setting, progress logging, dashboards, streaks, reminders within the app, and AI planning or summarising.',
    unsafeInterpretations:
      'No medical or clinical advice. No diagnosis, injury guidance, or calorie/weight prescriptions presented as professional advice. No storage of real health records.',
    displayOrder: 2,
  },
  {
    title: 'Book Recommendation App',
    slug: 'book-recommendation-app',
    description:
      'An app where users can browse book recommendations and save books to a personal reading list.',
    targetUser: 'Readers deciding what to read next.',
    expectedUseCase:
      'A user browses or searches recommendations, opens a book, and adds it to a personal reading list they can return to.',
    minimumCoreFlow: [
      'Browse or search a set of book recommendations',
      'Open a single book and see its details',
      'Add a book to a personal reading list',
      'Remove a book from the reading list',
      'See the reading list persist after a page reload',
    ],
    expectedEntities: ['Book', 'ReadingListItem', 'User'],
    aiOpportunity:
      'Recommend books from a described mood, a previous favourite, or the contents of the reading list, with a stated reason for each suggestion.',
    allowedScope:
      'Browsing, search, recommendation, reading lists, reviews, ratings, and outbound links to bookshops or libraries.',
    unsafeInterpretations:
      'No distribution of copyrighted book text. No scraping of paywalled or login-protected catalogues. Recommendations must not be presented as verified purchase links unless they genuinely are.',
    displayOrder: 3,
  },
  {
    title: 'Movie Watchlist',
    slug: 'movie-watchlist',
    description:
      'An app where users can search for movies and add them to a personal watchlist, with a simple rating system.',
    targetUser: 'Film viewers who keep losing track of what they meant to watch.',
    expectedUseCase:
      'A user searches for a film, adds it to their watchlist, marks it watched, and rates it.',
    minimumCoreFlow: [
      'Search for or browse films',
      'Add a film to a personal watchlist',
      'Mark a film as watched',
      'Give a film a rating',
      'See the watchlist and ratings persist after a page reload',
    ],
    expectedEntities: ['Movie', 'WatchlistItem', 'Rating', 'User'],
    aiOpportunity:
      'Suggest what to watch tonight based on mood, available time, or the existing watchlist, with a short reason for each pick.',
    allowedScope:
      'Search, watchlists, ratings, reviews, filtering, and recommendations.',
    unsafeInterpretations:
      'No streaming, hosting or linking to pirated content. No scraping of paywalled catalogues. Age ratings must not be misrepresented.',
    displayOrder: 4,
  },
  {
    title: 'Budget Tracker',
    slug: 'budget-tracker',
    description:
      'A simple app to track expenses and categorise them (e.g. food, travel) with a summary view.',
    targetUser: 'Individuals who want to understand where their money actually goes.',
    expectedUseCase:
      'A user records several expenses with categories and sees a summary of spending by category.',
    minimumCoreFlow: [
      'Record an expense with an amount, a category and a date',
      'See recorded expenses in a list',
      'Edit or delete an expense',
      'See a summary or breakdown of spending by category',
      'See recorded expenses persist after a page reload',
    ],
    expectedEntities: ['Expense', 'Category', 'Budget', 'User'],
    aiOpportunity:
      'Categorise an expense from its description, explain a spending pattern in plain language, or flag an unusual month against actual history.',
    allowedScope:
      'Manual expense entry, categorisation, budgets, summaries, charts, and export.',
    unsafeInterpretations:
      'No connection to real bank accounts or real financial credentials. No storage of real card or account numbers. No regulated financial advice. Demo data only.',
    displayOrder: 5,
  },
  {
    title: 'Collaborative Notetaker',
    slug: 'collaborative-notetaker',
    description:
      'A notetaker app where users can create, edit, and share notes with others in real time.',
    targetUser: 'Small teams or study groups keeping shared notes in one place.',
    expectedUseCase:
      'A user creates a note, edits it, shares it, and the shared version is visible to another session.',
    minimumCoreFlow: [
      'Create a note with a title and body',
      'Edit an existing note and save the change',
      'See the list of notes',
      'Share a note or make it accessible to someone else',
      'See the note and its edits persist after a page reload',
    ],
    expectedEntities: ['Note', 'Share', 'User'],
    aiOpportunity:
      'Summarise a long note, pull out action items, or answer a question using the contents of the notes themselves.',
    allowedScope:
      'Note CRUD, folders or tags, sharing, collaborative editing, search, and AI summarisation over the user’s own notes.',
    unsafeInterpretations:
      'No storage of real confidential or personal data in a demo. Sharing must not make private notes publicly discoverable without an explicit action.',
    displayOrder: 6,
  },
  {
    title: 'Website Content Scraper',
    slug: 'website-content-scraper',
    description:
      'An app that lets users input a website URL, scrapes basic content (e.g. titles, headings, or links), and saves results for later use.',
    targetUser: 'Researchers and marketers gathering structured information from public pages.',
    expectedUseCase:
      'A user enters a public URL, sees extracted titles, headings and links, and saves the result to review later.',
    minimumCoreFlow: [
      'Enter a website URL',
      'See extracted content such as titles, headings or links',
      'Handle an invalid or unreachable URL without breaking',
      'Save an extraction result',
      'See saved results persist after a page reload',
    ],
    expectedEntities: ['ScrapeJob', 'ExtractedItem', 'SavedResult', 'User'],
    aiOpportunity:
      'Summarise the scraped page, classify the extracted content, or pull out structured fields the user asked for.',
    allowedScope:
      'Scraping public, unauthenticated pages; extraction; saving; exporting; and AI summarisation of what was extracted.',
    unsafeInterpretations:
      'Never scrape authenticated, paywalled, private or internal-network targets. Never bypass a login, a paywall or a robots directive. Never scrape personal data. Automated testing of this idea uses a fixed, safe, public URL and never a URL suggested by the product itself.',
    displayOrder: 7,
  },
  {
    title: 'Travel Itinerary Planner',
    slug: 'travel-itinerary-planner',
    description:
      'A travel app where users create and manage trip itineraries, adding destinations, activities, and notes.',
    targetUser: 'People planning a short trip who currently keep plans scattered across chats and notes.',
    expectedUseCase:
      'A user creates a trip, adds day-wise activities with times, edits them, and views the full itinerary in one place.',
    minimumCoreFlow: [
      'Create a trip with a destination and dates',
      'Add an activity to a specific day',
      'Edit or delete an activity',
      'View the full day-wise itinerary',
      'See the itinerary persist after a page reload',
    ],
    expectedEntities: ['Trip', 'Day', 'Activity', 'User'],
    aiOpportunity:
      'Suggest activities for a city and theme, spot timing clashes in a day, or draft a first-pass itinerary from the trip length and interests.',
    allowedScope:
      'Trip and activity CRUD, day-wise views, sharing, notes, maps or calendar integration, and AI suggestions.',
    unsafeInterpretations:
      'No real bookings, payments or ticket purchases. No storage of real passport, visa or payment details. Safety information must not be presented as official government guidance.',
    displayOrder: 8,
  },
] as const;


/**
 * The approved ideas, as intake needs to see them.
 *
 * Derived from `IDEA_SEEDS` rather than written out again, so there is one list
 * and it cannot drift. Intake validates a sheet's Category against this instead
 * of against whatever a particular cohort happens to hold — the eight ideas are
 * a fact about the hackathon, not about a database row.
 *
 * That distinction is the bug this exists to close. Categories used to be read
 * from the mapped Judge cohort, and a cohort is only created by the first
 * Import — so the first Preview an operator ever runs had an empty list and
 * rejected all eight valid categories at once.
 */
export const APPROVED_IDEA_LABELS: readonly { slug: string; title: string }[] = IDEA_SEEDS.map(
  (idea) => ({ slug: idea.slug, title: idea.title }),
);
