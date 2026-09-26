/**
 * AIAP C14 — the eight product ideas.
 *
 * The internal Outskill submission product writes one of these EXACT titles
 * into the Google Sheet's "Category" column. Intake matches a Category by
 * normalised title or by slug, so the titles here are the contract with the
 * upstream form and must not be reworded.
 *
 * Only the ideas changed for C14. The rubric (`rubric-v2`) did not: an idea
 * definition says what this kind of product should do; the rubric says how
 * well the team built it, and the two are kept apart on purpose. Nothing here
 * carries a mark, a weight or a scoring rule.
 *
 * The build suggestions learners were given (a particular app builder, a
 * particular database, a particular model provider) are absent on purpose.
 * They are not judging criteria, and a team that used something else loses
 * nothing for it.
 *
 * Applied to the cohort with `scripts/configure-cohort-ideas.ts`, which reads
 * this file and reconciles the cohort mapped to `AIAP-C14` — never another.
 */

import type { IdeaCatalogue, IdeaDefinition } from '../../domain/idea-catalogue';

export const AIAP_C14_EXTERNAL_COHORT_ID = 'AIAP-C14';

export const AIAP_C14_IDEAS: readonly IdeaDefinition[] = [
  {
    title: 'Personal Health Manager',
    slug: 'personal-health-manager',
    description:
      'An app where users set health goals, log daily habits such as exercise, sleep, and water intake, and track progress through a simple dashboard.',
    targetUser:
      'Individuals who want a simple place to set personal health or wellness goals and consistently track everyday habits.',
    expectedUseCase:
      'A user creates a health goal or habit, records daily activity such as exercise, sleep or water intake, and views their progress over time in a simple dashboard.',
    minimumCoreFlow: [
      'Create or select a health goal or habit to track',
      'Log at least one daily habit entry',
      'View logged activity or progress in a dashboard/history',
      'Edit or correct a logged entry where supported',
      'Return to the product and see saved goals/logs persist',
    ],
    expectedEntities: ['HealthGoal', 'Habit', 'HabitLog', 'User'],
    aiOpportunity:
      "Summarise the user's logged habits and progress, identify simple patterns in their own data, or provide a plain-language progress summary.",
    allowedScope:
      'Personal goal tracking, habit logging, progress dashboards, reminders, summaries and AI-generated reflections based on user-provided/demo data.',
    unsafeInterpretations:
      'No medical diagnosis. No treatment recommendations. No medication advice. No clinical claims. Automated judging must use demo/synthetic health information.',
    displayOrder: 1,
  },
  {
    title: 'Personal Finance Manager',
    slug: 'personal-finance-manager',
    description:
      'An app where users track income and expenses, set category-wise budgets, and view spending patterns through a monthly dashboard.',
    targetUser:
      'Individuals who want to understand their income, expenses, budgets and spending patterns in one place.',
    expectedUseCase:
      'A user records income and expenses, organises spending into categories, sets a budget and views a monthly spending summary.',
    minimumCoreFlow: [
      'Record an income entry',
      'Record an expense with an amount and category',
      'Create or set a category-wise budget',
      'View a monthly/category spending summary or dashboard',
      'Edit or correct a financial entry where supported',
      'See saved entries and budgets persist after reload',
    ],
    expectedEntities: ['IncomeEntry', 'Expense', 'Category', 'Budget', 'User'],
    aiOpportunity:
      'Categorise an expense from its description, explain spending patterns in plain language, summarise monthly spending or surface useful patterns from user-provided data.',
    allowedScope:
      'Manual/demo income and expense entry, categories, budgets, summaries, charts, exports and AI categorisation/explanation.',
    unsafeInterpretations:
      'No real bank credential collection during automated testing. No real card/account details. No regulated financial advice. No guaranteed-return claims. Use demo financial data.',
    displayOrder: 2,
  },
  {
    title: 'Collaborative Notetaker',
    slug: 'collaborative-notetaker',
    description:
      'An app where users can create, organise, edit, and share notes with others in real time, with AI-generated summaries and key points.',
    targetUser: 'Individuals, study groups or small teams who need to create, organise and share notes.',
    expectedUseCase:
      'A user creates a note, edits and organises it, shares it with another user/session, and generates an AI summary or key points.',
    minimumCoreFlow: [
      'Create a note with a title and body',
      'Edit an existing note and save it',
      'See or organise notes',
      'Share a note or make it accessible to an authorised second user/session',
      'Generate an AI summary or key points',
      'See saved notes persist after reload',
    ],
    expectedEntities: ['Note', 'Share', 'Collaborator', 'User'],
    aiOpportunity:
      'Summarise long notes, extract key points, identify action items or answer questions using note content.',
    allowedScope:
      'Note CRUD, folders/tags, search, explicit sharing, collaborative editing and AI summarisation.',
    unsafeInterpretations:
      'Do not use real confidential/personal data during automated judging. Sharing must not unintentionally expose private notes. Do not scrape unrelated external content.',
    displayOrder: 3,
  },
  {
    title: 'Task Management App',
    slug: 'task-management-app',
    description:
      'An app where users turn meeting notes into editable action items, assign owners and deadlines, and track completion on a task board. AI extracts owners and deadlines where mentioned for users to review.',
    targetUser: 'Teams or individuals who want to turn meeting notes into trackable action items.',
    expectedUseCase:
      'A user pastes meeting notes, AI extracts action items, the user reviews/edits them, assigns ownership/deadlines and tracks completion.',
    minimumCoreFlow: [
      'Enter or paste meeting notes',
      'Generate/extract action items',
      'Review/edit generated action items',
      'Assign owner and/or deadline',
      'Track status or mark an item complete',
      'See saved tasks persist after reload',
    ],
    expectedEntities: ['MeetingNote', 'ActionItem', 'Assignee', 'Deadline', 'TaskBoard', 'User'],
    aiOpportunity: 'Extract tasks, owners and deadlines from meeting notes.',
    allowedScope:
      'Meeting-note input, task CRUD, owners, deadlines, task boards, completion tracking and AI-assisted extraction.',
    unsafeInterpretations:
      'AI-generated assignments must remain editable. Do not send external messages or perform third-party actions without explicit user action. Use synthetic/demo meeting data.',
    displayOrder: 4,
  },
  {
    title: 'AI Interior Makeover',
    slug: 'ai-interior-makeover',
    description:
      'An app where users upload a room photo and select an interior design style. AI generates makeover concepts that users can compare with the original photo and save to a personal gallery.',
    targetUser: 'People seeking visual inspiration when redesigning or redecorating a room.',
    expectedUseCase:
      'Upload room image → choose style → generate makeover → compare original/generated → save result.',
    minimumCoreFlow: [
      'Upload/select room image',
      'Choose design style',
      'Generate makeover concept',
      'View/compare generated output',
      'Save result',
      'Revisit saved result where supported',
    ],
    expectedEntities: ['RoomImage', 'DesignStyle', 'MakeoverConcept', 'GalleryItem', 'User'],
    aiOpportunity:
      'Generate/edit a room image into the selected visual style and optionally explain design choices.',
    allowedScope:
      'Room-image upload, style selection, AI image generation/editing, before/after comparison and galleries.',
    unsafeInterpretations:
      'Use safe demo room imagery. No architectural/structural/electrical safety claims. Do not claim generated measurements or material properties are verified.',
    displayOrder: 5,
  },
  {
    title: 'Resume-to-Interview Coach',
    slug: 'resume-to-interview-coach',
    description:
      'An app where users upload a resume and paste a job description to practise personalised interview questions. AI gives feedback on written answers, and users can save practice sessions.',
    targetUser: 'Job seekers wanting interview practice tailored to their resume and target job.',
    expectedUseCase:
      'Resume + JD → personalised interview questions → practice answer → AI feedback → save session.',
    minimumCoreFlow: [
      'Upload/provide resume',
      'Provide job description',
      'Generate personalised interview questions',
      'Enter a practice answer',
      'Receive AI feedback',
      'Save/revisit practice session',
    ],
    expectedEntities: [
      'Resume',
      'JobDescription',
      'InterviewQuestion',
      'PracticeAnswer',
      'Feedback',
      'PracticeSession',
      'User',
    ],
    aiOpportunity:
      'Generate questions grounded in resume/JD and provide constructive answer feedback.',
    allowedScope:
      'Resume/JD parsing, interview-question generation, written practice, coaching feedback and saved practice history.',
    unsafeInterpretations:
      'Do not make hiring decisions. Do not rank real candidates. Do not infer protected characteristics. Use synthetic/demo resume data during automated judging.',
    displayOrder: 6,
  },
  {
    title: 'Pet Care Companion',
    slug: 'pet-care-companion',
    description:
      'An app where users create pet profiles, manage feeding and walking routines, store vaccination records, and organise grooming and vet appointments. AI turns care instructions into editable checklists.',
    targetUser: 'Pet owners organising routine care information and reminders.',
    expectedUseCase:
      'Create pet → manage routines/records/appointments → provide care instructions → receive editable checklist.',
    minimumCoreFlow: [
      'Create pet profile',
      'Create/manage feeding or walking routine',
      'Add/view vaccination or care record',
      'Add grooming/vet appointment',
      'Generate editable checklist from care instructions',
      'See data persist after reload',
    ],
    expectedEntities: ['Pet', 'Routine', 'VaccinationRecord', 'Appointment', 'CareChecklist', 'User'],
    aiOpportunity:
      'Turn user-provided care instructions into structured editable checklists or routine summaries.',
    allowedScope:
      'Pet profiles, routines, records, appointments, reminders, checklists and AI structuring.',
    unsafeInterpretations:
      'No veterinary diagnosis. No medication dosing. No emergency medical advice. Do not present AI output as professional veterinary guidance.',
    displayOrder: 7,
  },
  {
    title: 'Campaign Planner',
    slug: 'campaign-planner',
    description:
      'An app where users enter a business brief, target audience, campaign goal, and duration to create an editable marketing calendar. AI generates content ideas, ad scripts, campaign copy, and creative briefs.',
    targetUser: 'Marketers, founders or small teams creating campaign plans.',
    expectedUseCase:
      'Business brief + audience + goal + duration → editable marketing calendar → AI-generated content/copy → save/edit campaign.',
    minimumCoreFlow: [
      'Enter business/campaign brief',
      'Provide target audience, goal and duration',
      'Generate campaign plan/calendar',
      'Generate at least one content idea, ad script, copy item or creative brief',
      'Edit generated content',
      'Save/revisit campaign',
    ],
    expectedEntities: [
      'Campaign',
      'Audience',
      'CampaignGoal',
      'CalendarItem',
      'ContentAsset',
      'CreativeBrief',
      'User',
    ],
    aiOpportunity:
      'Generate campaign structure, content ideas, scripts, copy, creative briefs and variations grounded in the supplied brief.',
    allowedScope:
      'Campaign planning, audience/goal input, marketing calendars, AI content generation, editing and saved campaigns.',
    unsafeInterpretations:
      'Do not claim unverified campaign performance. Do not publish to/spend from real advertising accounts during automated judging. Do not generate malicious/deceptive prohibited campaign material.',
    displayOrder: 8,
  },
];

/**
 * The C14 catalogue, bound to its external cohort identity.
 *
 * `settings` records what C14 runs with: a private top 10 and three human-
 * chosen winners. They are applied by the configuration script only when asked
 * for explicitly, and only to the cohort mapped to `AIAP-C14`.
 */
export const AIAP_C14_CATALOGUE: IdeaCatalogue = {
  externalCohortId: AIAP_C14_EXTERNAL_COHORT_ID,
  expectedCohortNameIncludes: 'AIAP C14',
  ideas: AIAP_C14_IDEAS,
  settings: {
    shortlistTarget: 10,
    finalSelectionTarget: 3,
  },
};
