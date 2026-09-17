require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Project = require('../models/Project');
const Task = require('../models/Task');
const TimeLog = require('../models/TimeLog');
const Attendance = require('../models/Attendance');
const DeductionRule = require('../models/DeductionRule');
const LeaveRequest = require('../models/LeaveRequest');
const Holiday = require('../models/Holiday');

// Ensure uploads/scopes directory exists with dummy sample files
const scopesDir = path.join(__dirname, '../../uploads/scopes');
if (!fs.existsSync(scopesDir)) {
  fs.mkdirSync(scopesDir, { recursive: true });
}

// Create sample scope documents
const sampleFiles = [
  { name: 'NX-AI-01-scope-spec.pdf', content: '%PDF-1.4 Neximet Agentic AI Specification Document - Comprehensive Architectural Plan & Deliverables' },
  { name: 'NX-SEO-04-strategy.pdf', content: '%PDF-1.4 Neximet Digital Marketing & SEO Strategy Document - Keyword clusters & Backlink target matrix' },
  { name: 'NX-GD-02-brand-guide.pdf', content: '%PDF-1.4 Neximet Brand Identity System - Color Palettes, Typography, and Asset Specs' },
  { name: 'NX-WP-08-architecture.pdf', content: '%PDF-1.4 Neximet WordPress Enterprise Architecture - Custom Gutenberg Blocks and WooCommerce API' },
];

sampleFiles.forEach((f) => {
  const filePath = path.join(scopesDir, f.name);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, f.content);
  }
});

const seedDatabase = async () => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/neximet_portal';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB for seeding...');

    // Clear existing collections
    await User.deleteMany({});
    await Project.deleteMany({});
    await Task.deleteMany({});
    await TimeLog.deleteMany({});
    await Attendance.deleteMany({});
    await DeductionRule.deleteMany({});
    await LeaveRequest.deleteMany({});
    await Holiday.deleteMany({});

    console.log('Cleared existing collections.');

    // 1. Seed Users
    const usersData = [
      {
        name: 'Alex Vance',
        email: 'ceo@neximet.com',
        password: 'password123',
        role: 'CEO',
        department: 'Executive',
        designation: 'Chief Executive Officer',
        baseSalary: 450000,
        dailyWage: 15000,
        phone: '+92 (300) 890-1122',
        leaveBalances: { casual: 15, sick: 10, annual: 20 },
      },
      {
        name: 'Sarah Jenkins',
        email: 'pm@neximet.com',
        password: 'password123',
        role: 'Project Manager',
        department: 'Software Development',
        designation: 'Senior Technical Project Manager',
        baseSalary: 280000,
        dailyWage: 9333,
        phone: '+92 (321) 782-4431',
        leaveBalances: { casual: 10, sick: 8, annual: 14 },
      },
      {
        name: 'Marcus Chen',
        email: 'marcus.dev@neximet.com',
        password: 'password123',
        role: 'Team Manager',
        department: 'Software Development',
        designation: 'Lead Software Architect',
        baseSalary: 240000,
        dailyWage: 8000,
        phone: '+92 (333) 662-8819',
        leaveBalances: { casual: 9, sick: 7, annual: 12 },
      },
      {
        name: 'Emily Watson',
        email: 'emily.seo@neximet.com',
        password: 'password123',
        role: 'Team Manager',
        department: 'Digital Marketing (SEO)',
        designation: 'Head of SEO & Growth',
        baseSalary: 210000,
        dailyWage: 7000,
        phone: '+92 (345) 554-9102',
        leaveBalances: { casual: 10, sick: 8, annual: 14 },
      },
      {
        name: 'Sofia Rivera',
        email: 'sofia.design@neximet.com',
        password: 'password123',
        role: 'Team Manager',
        department: 'Graphics Designing',
        designation: 'Creative Design Director',
        baseSalary: 200000,
        dailyWage: 6667,
        phone: '+92 (312) 441-7733',
        leaveBalances: { casual: 8, sick: 8, annual: 13 },
      },
      {
        name: 'Tariq Mehmood',
        email: 'tariq.wp@neximet.com',
        password: 'password123',
        role: 'Team Manager',
        department: 'WordPress Team',
        designation: 'WordPress Lead Engineer',
        baseSalary: 190000,
        dailyWage: 6333,
        phone: '+92 (301) 332-9011',
        leaveBalances: { casual: 10, sick: 6, annual: 14 },
      },
      {
        name: 'Bilal Khan',
        email: 'bilal.dev@neximet.com',
        password: 'password123',
        role: 'Team Member',
        department: 'Software Development',
        designation: 'Full-Stack Software Engineer',
        baseSalary: 140000,
        dailyWage: 4667,
        phone: '+92 (322) 221-8844',
        leaveBalances: { casual: 7, sick: 5, annual: 11 },
      },
      {
        name: 'Chloe Adams',
        email: 'chloe.seo@neximet.com',
        password: 'password123',
        role: 'Team Member',
        department: 'Digital Marketing (SEO)',
        designation: 'Senior Technical SEO Analyst',
        baseSalary: 130000,
        dailyWage: 4333,
        phone: '+92 (334) 119-3388',
        leaveBalances: { casual: 9, sick: 8, annual: 12 },
      },
      {
        name: 'Leo Zhang',
        email: 'leo.design@neximet.com',
        password: 'password123',
        role: 'Team Member',
        department: 'Graphics Designing',
        designation: 'UI/UX & Brand Designer',
        baseSalary: 135000,
        dailyWage: 4500,
        phone: '+92 (300) 998-1120',
        leaveBalances: { casual: 10, sick: 7, annual: 14 },
      },
      {
        name: 'Zainab Malik',
        email: 'zainab.wp@neximet.com',
        password: 'password123',
        role: 'Team Member',
        department: 'WordPress Team',
        designation: 'WooCommerce & Theme Developer',
        baseSalary: 125000,
        dailyWage: 4167,
        phone: '+92 (302) 887-6644',
        leaveBalances: { casual: 8, sick: 6, annual: 10 },
      },
    ];

    const createdUsers = [];
    for (const u of usersData) {
      const userDoc = new User(u);
      await userDoc.save();
      createdUsers.push(userDoc);
    }
    console.log(`Seeded ${createdUsers.length} users.`);

    const userByEmail = {};
    createdUsers.forEach((u) => {
      userByEmail[u.email] = u;
    });

    // 2. Seed Deduction Rule
    const deductionRule = new DeductionRule({
      title: 'Neximet Enterprise Attendance & Late Deduction Policy',
      shiftStartTime: '09:00',
      shiftEndTime: '18:00',
      gracePeriodMinutes: 15,
      lateThresholdMinutes: 30,
      deductionType: 'percentage',
      fixedDeductionAmount: 1000,
      percentageDeductionRate: 5,
      halfDayThresholdMinutes: 60,
      fullDayAbsentThresholdMinutes: 180,
      consecutiveLateThreshold: 3,
      consecutivePenaltyMultiplier: 1.5,
      currencySymbol: 'PKR',
      isActive: true,
      updatedBy: userByEmail['ceo@neximet.com']._id,
    });
    await deductionRule.save();
    console.log('Seeded Deduction Policy.');

    // 3. Seed Projects
    const projectsData = [
      {
        title: 'Enterprise Agentic AI Automation System',
        code: 'NX-AI-01',
        clientName: 'Apex Healthtech Global',
        department: 'Software Development',
        description: 'Multi-agent autonomous customer workflows, medical triage intelligence, and real-time appointment booking integrations.',
        status: 'in_progress',
        priority: 'Critical',
        completionPercentage: 68,
        startDate: new Date('2026-08-01'),
        deadline: new Date('2026-10-30'),
        budget: 6500000,
        estimatedHours: 420,
        spentHours: 290,
        projectManager: userByEmail['pm@neximet.com']._id,
        scopeDocument: {
          fileName: 'NX-AI-01-scope-spec.pdf',
          originalName: 'Apex-AgenticAI-Scope-Specification-v2.pdf',
          fileUrl: '/uploads/scopes/NX-AI-01-scope-spec.pdf',
          fileType: 'application/pdf',
          fileSize: 4200000,
          summary: 'Detailed system architecture specification: LLM routing orchestration, LangGraph DAGs, HIPAA compliant vector embeddings, and SLA guarantees.',
        },
        credentials: [
          {
            platform: 'OpenAI Enterprise API',
            environment: 'Production',
            usernameOrEmail: 'org-neximet-prod@openai.com',
            passwordOrKey: 'sk-proj-9182371982739182739182379182739182',
            endpointUrl: 'https://api.openai.com/v1',
            notes: 'Primary LLM API Gateway with tiered rate limits and private logging',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
          {
            platform: 'Pinecone Serverless Vector Store',
            environment: 'Production',
            usernameOrEmail: 'devops@neximet.com',
            passwordOrKey: 'pc_key_849204928104820194820',
            endpointUrl: 'https://apex-index-us-east-1.pinecone.io',
            notes: 'Production vector search index holding 1.2M medical document embeddings',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager'],
          },
          {
            platform: 'AWS Lambda & Bedrock',
            environment: 'Staging',
            usernameOrEmail: 'arn:aws:iam::8829102910:user/neximet-ai-runner',
            passwordOrKey: 'AKIAIOSFODNN7EXAMPLE_SECRET_819283019',
            endpointUrl: 'https://console.aws.amazon.com/bedrock',
            notes: 'Fallback serverless Claude 3.5 Sonnet processing cluster',
            visibleToRoles: ['CEO', 'Project Manager'],
          },
        ],
        milestones: [
          { title: 'Phase 1: Architecture & Vector Pipeline', deadline: new Date('2026-08-20'), status: 'completed', progress: 100 },
          { title: 'Phase 2: Autonomous Agent Tools & Slack/Webhook Bridge', deadline: new Date('2026-09-25'), status: 'in_progress', progress: 75 },
          { title: 'Phase 3: Load Testing & Security Audit', deadline: new Date('2026-10-15'), status: 'pending', progress: 10 },
          { title: 'Phase 4: Client Production Cutover', deadline: new Date('2026-10-30'), status: 'pending', progress: 0 },
        ],
        assignedMembers: [
          { user: userByEmail['marcus.dev@neximet.com']._id, roleInProject: 'Tech Lead / Architect', allocatedHoursPerWeek: 30 },
          { user: userByEmail['bilal.dev@neximet.com']._id, roleInProject: 'Full-Stack AI Engineer', allocatedHoursPerWeek: 35 },
          { user: userByEmail['pm@neximet.com']._id, roleInProject: 'Project Manager', allocatedHoursPerWeek: 15 },
        ],
      },
      {
        title: 'Global SaaS Organic SEO & Keyword Cluster Engine',
        code: 'NX-SEO-04',
        clientName: 'CloudMatrix Inc.',
        department: 'Digital Marketing (SEO)',
        description: 'Complete programmatic SEO rebuild, topic clusters, backlink velocity campaigns, and Core Web Vitals optimization.',
        status: 'in_progress',
        priority: 'High',
        completionPercentage: 54,
        startDate: new Date('2026-07-15'),
        deadline: new Date('2026-11-15'),
        budget: 3800000,
        estimatedHours: 280,
        spentHours: 160,
        projectManager: userByEmail['pm@neximet.com']._id,
        scopeDocument: {
          fileName: 'NX-SEO-04-strategy.pdf',
          originalName: 'CloudMatrix-SEO-Comprehensive-Strategy.pdf',
          fileUrl: '/uploads/scopes/NX-SEO-04-strategy.pdf',
          fileType: 'application/pdf',
          fileSize: 3100000,
          summary: 'Roadmap for 15,000 keyword indexation, crawl budget optimization, and monthly tier-1 PR mentions.',
        },
        credentials: [
          {
            platform: 'Ahrefs Enterprise Suite',
            environment: 'Production',
            usernameOrEmail: 'seo-team@neximet.com',
            passwordOrKey: 'ahr_token_8839201948291048201',
            endpointUrl: 'https://app.ahrefs.com/dashboard',
            notes: 'Shared keyword analytics and backlink radar workspace',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
          {
            platform: 'Google Search Console API',
            environment: 'Production',
            usernameOrEmail: 'gsc-service-account@neximet-seo.iam.gserviceaccount.com',
            passwordOrKey: 'service_account_private_key_gsc_994829',
            endpointUrl: 'https://search.google.com/search-console',
            notes: 'Automated inspection and indexing submission credentials',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
        ],
        milestones: [
          { title: 'Technical Crawl & Remediation', deadline: new Date('2026-08-10'), status: 'completed', progress: 100 },
          { title: '100+ Programmatic Landing Page Templates', deadline: new Date('2026-09-30'), status: 'in_progress', progress: 60 },
          { title: 'High-Authority Outreach & Digital PR', deadline: new Date('2026-11-15'), status: 'pending', progress: 20 },
        ],
        assignedMembers: [
          { user: userByEmail['emily.seo@neximet.com']._id, roleInProject: 'SEO Director', allocatedHoursPerWeek: 20 },
          { user: userByEmail['chloe.seo@neximet.com']._id, roleInProject: 'Lead Technical SEO', allocatedHoursPerWeek: 35 },
        ],
      },
      {
        title: 'Neximet Brand Identity & Design System 2.0',
        code: 'NX-GD-02',
        clientName: 'Neximet Core Group',
        department: 'Graphics Designing',
        description: 'Complete refresh of Neximet corporate brand guidelines, marketing 3D assets, social kits, and web design component tokens.',
        status: 'review',
        priority: 'High',
        completionPercentage: 88,
        startDate: new Date('2026-08-10'),
        deadline: new Date('2026-09-28'),
        budget: 2500000,
        estimatedHours: 200,
        spentHours: 175,
        projectManager: userByEmail['pm@neximet.com']._id,
        scopeDocument: {
          fileName: 'NX-GD-02-brand-guide.pdf',
          originalName: 'Neximet-BrandSystem-Specification.pdf',
          fileUrl: '/uploads/scopes/NX-GD-02-brand-guide.pdf',
          fileType: 'application/pdf',
          fileSize: 5800000,
          summary: 'Design system specifications: typography, color matrices, glassmorphism tokens, and responsive UI components.',
        },
        credentials: [
          {
            platform: 'Figma Enterprise Organization',
            environment: 'Production',
            usernameOrEmail: 'figma-admin@neximet.com',
            passwordOrKey: 'fig_pat_918239018239018230918230918',
            endpointUrl: 'https://www.figma.com/files/team/91823901/Neximet',
            notes: 'Master UI Kit and Vector library repository',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
          {
            platform: 'Adobe Creative Cloud Team Hub',
            environment: 'Production',
            usernameOrEmail: 'design-assets@neximet.com',
            passwordOrKey: 'AdobeCC_Pass_2026_SecureKey!',
            endpointUrl: 'https://assets.adobe.com',
            notes: 'High-res 3D Renders and AfterEffects motion templates',
            visibleToRoles: ['CEO', 'Team Manager'],
          },
        ],
        milestones: [
          { title: 'Color Palette & Typography System', deadline: new Date('2026-08-25'), status: 'completed', progress: 100 },
          { title: 'Component Library & 3D Illustration Kit', deadline: new Date('2026-09-15'), status: 'completed', progress: 100 },
          { title: 'Executive Review & Motion Asset Package', deadline: new Date('2026-09-28'), status: 'in_progress', progress: 80 },
        ],
        assignedMembers: [
          { user: userByEmail['sofia.design@neximet.com']._id, roleInProject: 'Design Lead', allocatedHoursPerWeek: 25 },
          { user: userByEmail['leo.design@neximet.com']._id, roleInProject: 'UI/UX Designer', allocatedHoursPerWeek: 35 },
        ],
      },
      {
        title: 'High-Traffic Headless WordPress E-Commerce',
        code: 'NX-WP-08',
        clientName: 'LuxeLiving Direct Australia',
        department: 'WordPress Team',
        description: 'Next.js storefront powered by WordPress REST / GraphQL backend, WooCommerce subscription plugins, and edge caching.',
        status: 'in_progress',
        priority: 'Critical',
        completionPercentage: 42,
        startDate: new Date('2026-08-18'),
        deadline: new Date('2026-11-20'),
        budget: 4500000,
        estimatedHours: 350,
        spentHours: 150,
        projectManager: userByEmail['pm@neximet.com']._id,
        scopeDocument: {
          fileName: 'NX-WP-08-architecture.pdf',
          originalName: 'LuxeLiving-Headless-WordPress-Spec.pdf',
          fileUrl: '/uploads/scopes/NX-WP-08-architecture.pdf',
          fileType: 'application/pdf',
          fileSize: 4500000,
          summary: 'Headless WP setup: WPGraphQL, WooCommerce custom checkout, Redis caching, and automated sync webhooks.',
        },
        credentials: [
          {
            platform: 'WordPress Admin Console',
            environment: 'Production',
            usernameOrEmail: 'sysadmin@luxeliving.neximet.cloud',
            passwordOrKey: 'Wp_Admin_Secure_Luxe!2026#99',
            endpointUrl: 'https://luxeliving.neximet.cloud/wp-admin',
            notes: 'Primary CMS content & catalog administration dashboard',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
          {
            platform: 'Cloudflare Edge CDN & WAF',
            environment: 'Production',
            usernameOrEmail: 'devops@neximet.com',
            passwordOrKey: 'cf_api_tok_892109283019820391823901',
            endpointUrl: 'https://dash.cloudflare.com',
            notes: 'Edge caching rules, SSL configuration, and DDoS shielding',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager'],
          },
          {
            platform: 'Stripe Payments Production Keys',
            environment: 'Production',
            usernameOrEmail: 'billing@luxeliving.com',
            passwordOrKey: 'rk_live_XXXX_REPLACE_WITH_REAL_STRIPE_KEY',
            endpointUrl: 'https://dashboard.stripe.com',
            notes: 'Restricted key with webhook signing and charge creation only',
            visibleToRoles: ['CEO', 'Project Manager'],
          },
        ],
        milestones: [
          { title: 'Custom Theme & ACF Gutenberg Architecture', deadline: new Date('2026-09-05'), status: 'completed', progress: 100 },
          { title: 'WooCommerce Custom REST API & Cart Sync', deadline: new Date('2026-10-10'), status: 'in_progress', progress: 50 },
          { title: 'Redis Object Cache & Payment Gateway Testing', deadline: new Date('2026-11-05'), status: 'pending', progress: 0 },
        ],
        assignedMembers: [
          { user: userByEmail['tariq.wp@neximet.com']._id, roleInProject: 'WordPress Architect', allocatedHoursPerWeek: 30 },
          { user: userByEmail['zainab.wp@neximet.com']._id, roleInProject: 'WP / WooCommerce Dev', allocatedHoursPerWeek: 35 },
        ],
      },
      {
        title: 'FinTech Real-Time Transaction Analyzer',
        code: 'NX-DEV-09',
        clientName: 'PayStream Global UK',
        department: 'Software Development',
        description: 'Microservice data streaming pipeline, WebSocket live feeds, fraud heuristics, and audit-ready reporting.',
        status: 'planning',
        priority: 'Medium',
        completionPercentage: 15,
        startDate: new Date('2026-09-10'),
        deadline: new Date('2026-12-15'),
        budget: 52000,
        estimatedHours: 380,
        spentHours: 40,
        projectManager: userByEmail['pm@neximet.com']._id,
        credentials: [
          {
            platform: 'Kafka Cloud Streaming Cluster',
            environment: 'Staging',
            usernameOrEmail: 'client-key-kafka-paystream',
            passwordOrKey: 'kafka_sec_tok_991823091820391820',
            endpointUrl: 'https://paystream.aws.confluent.cloud',
            notes: 'Staging event broker for processing ledger transactions',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager'],
          },
        ],
        milestones: [
          { title: 'Kafka Schema Registry & Data Models', deadline: new Date('2026-09-30'), status: 'in_progress', progress: 30 },
          { title: 'Fraud Detection Engine MVP', deadline: new Date('2026-10-30'), status: 'pending', progress: 0 },
        ],
        assignedMembers: [
          { user: userByEmail['marcus.dev@neximet.com']._id, roleInProject: 'Backend Lead', allocatedHoursPerWeek: 20 },
          { user: userByEmail['bilal.dev@neximet.com']._id, roleInProject: 'Full-Stack Developer', allocatedHoursPerWeek: 30 },
        ],
      },
    ];

    const createdProjects = [];
    for (const p of projectsData) {
      const projDoc = new Project(p);
      await projDoc.save();
      createdProjects.push(projDoc);
    }
    console.log(`Seeded ${createdProjects.length} detailed projects.`);

    // 4. Seed Rich Jira Issues & TimeLogs across projects
    const aiProj = createdProjects[0];
    const seoProj = createdProjects[1];
    const gdProj = createdProjects[2];
    const wpProj = createdProjects[3];
    const devProj = createdProjects[4];

    const tasksToCreate = [
      // AI Project Issues
      {
        project: aiProj._id,
        issueKey: 'NX-AI-101',
        issueType: 'epic',
        title: 'Core RAG Architecture & Vector Pipeline',
        description: 'End-to-end embedding pipeline, vector indexing in Pinecone, and semantic retrieval evaluation.',
        assignedTo: userByEmail['marcus.dev@neximet.com']._id,
        reporter: userByEmail['pm@neximet.com']._id,
        status: 'done',
        priority: 'High',
        storyPoints: 13,
        labels: ['ai', 'backend', 'architecture'],
        order: 0,
        subtasks: [
          { title: 'Evaluate Pinecone vs Weaviate benchmarks', completed: true },
          { title: 'Implement chunking algorithm with overlap', completed: true },
          { title: 'Vector index security & metadata filtering', completed: true },
        ],
        comments: [
          { user: userByEmail['marcus.dev@neximet.com']._id, text: 'Pinecone serverless index configured in us-east-1.' },
        ],
        estimatedHours: 40,
        spentHours: 38,
        deadline: new Date('2026-08-20'),
      },
      {
        project: aiProj._id,
        issueKey: 'NX-AI-102',
        issueType: 'story',
        title: 'Autonomous Multi-Agent Supervisor Routing',
        description: 'Implement LangGraph supervisor pattern to route patient triage between booking, prescription verification, and escalation agents.',
        assignedTo: userByEmail['bilal.dev@neximet.com']._id,
        reporter: userByEmail['marcus.dev@neximet.com']._id,
        status: 'in_progress',
        priority: 'Urgent',
        storyPoints: 8,
        labels: ['agents', 'langchain', 'router'],
        order: 1,
        subtasks: [
          { title: 'Define LangGraph state schema', completed: true },
          { title: 'Connect triage agent with appointment calendar tool', completed: true },
          { title: 'Unit test fallback loops on LLM hallucinations', completed: false },
          { title: 'Add audit logging for all agent tool executions', completed: false },
        ],
        comments: [
          { user: userByEmail['pm@neximet.com']._id, text: 'Please ensure calendar API handles slot conflict exceptions gracefully.' },
          { user: userByEmail['bilal.dev@neximet.com']._id, text: 'Calendar retry mechanism is implemented; testing edge cases today.' },
        ],
        estimatedHours: 32,
        spentHours: 20,
        deadline: new Date('2026-09-24'),
      },
      {
        project: aiProj._id,
        issueKey: 'NX-AI-103',
        issueType: 'task',
        title: 'Streaming SSE Response Gateway for Frontend UI',
        description: 'Expose Server-Sent Events stream from FastAPI agent server to Next.js portal client.',
        assignedTo: userByEmail['bilal.dev@neximet.com']._id,
        reporter: userByEmail['marcus.dev@neximet.com']._id,
        status: 'review',
        priority: 'High',
        storyPoints: 5,
        labels: ['sse', 'api', 'fastapi'],
        order: 2,
        subtasks: [
          { title: 'Implement SSE generator yield endpoint', completed: true },
          { title: 'Format token chunks as JSON protocol', completed: true },
          { title: 'Handle client disconnect token cancellation', completed: true },
        ],
        comments: [
          { user: userByEmail['marcus.dev@neximet.com']._id, text: 'PR #42 opened. Reviewing memory usage on concurrent streams.' },
        ],
        estimatedHours: 16,
        spentHours: 14,
        deadline: new Date('2026-09-21'),
      },
      {
        project: aiProj._id,
        issueKey: 'NX-AI-104',
        issueType: 'bug',
        title: 'Rate-Limit Exceeded uncaught in Bedrock Claude Fallback',
        description: 'When OpenAI primary hits 429 TPM quota, AWS Bedrock fails to authenticate due to expired STS token.',
        assignedTo: userByEmail['marcus.dev@neximet.com']._id,
        reporter: userByEmail['bilal.dev@neximet.com']._id,
        status: 'todo',
        priority: 'Urgent',
        storyPoints: 3,
        labels: ['bug', 'bedrock', 'resilience'],
        order: 3,
        subtasks: [
          { title: 'Reproduce token expiry with mocked 429 response', completed: false },
          { title: 'Implement exponential backoff with auto STS refresh', completed: false },
        ],
        comments: [],
        estimatedHours: 8,
        spentHours: 0,
        deadline: new Date('2026-09-22'),
      },
      {
        project: aiProj._id,
        issueKey: 'NX-AI-105',
        issueType: 'story',
        title: 'HIPAA Compliance Audit Trail & Token Redaction',
        description: 'Mask PII (National ID, phone, medical history) before passing raw user prompts to external model providers.',
        assignedTo: userByEmail['bilal.dev@neximet.com']._id,
        reporter: userByEmail['ceo@neximet.com']._id,
        status: 'backlog',
        priority: 'Medium',
        storyPoints: 5,
        labels: ['security', 'hipaa', 'compliance'],
        order: 4,
        subtasks: [
          { title: 'Configure Presidio PII anonymizer', completed: false },
          { title: 'Benchmark latency overhead on prompt filter', completed: false },
        ],
        comments: [],
        estimatedHours: 24,
        spentHours: 0,
        deadline: new Date('2026-10-15'),
      },

      // SEO Project Issues
      {
        project: seoProj._id,
        issueKey: 'NX-SEO-101',
        issueType: 'story',
        title: 'Target Keyword Clusters & Search Intent Mapping',
        description: 'Identify 500+ high-volume commercial intent keywords for fintech payment gateway comparison queries.',
        assignedTo: userByEmail['chloe.seo@neximet.com']._id,
        reporter: userByEmail['emily.seo@neximet.com']._id,
        status: 'done',
        priority: 'High',
        storyPoints: 8,
        labels: ['keywords', 'research', 'ahrefs'],
        order: 0,
        subtasks: [
          { title: 'Extract competitor keyword gap report', completed: true },
          { title: 'Filter for search volume > 1500 and KD < 45', completed: true },
        ],
        comments: [],
        estimatedHours: 20,
        spentHours: 19,
        deadline: new Date('2026-08-30'),
      },
      {
        project: seoProj._id,
        issueKey: 'NX-SEO-102',
        issueType: 'task',
        title: 'Technical Core Web Vitals Optimization',
        description: 'Improve LCP to under 1.8s and eliminate CLS on high-converting product comparison landing pages.',
        assignedTo: userByEmail['chloe.seo@neximet.com']._id,
        reporter: userByEmail['emily.seo@neximet.com']._id,
        status: 'in_progress',
        priority: 'Medium',
        storyPoints: 5,
        labels: ['technical-seo', 'core-web-vitals', 'performance'],
        order: 1,
        subtasks: [
          { title: 'Defer third-party tracking scripts (Hotjar, GTM)', completed: true },
          { title: 'Convert hero images to WebP/AVIF with explicit dimensions', completed: false },
        ],
        comments: [],
        estimatedHours: 16,
        spentHours: 9,
        deadline: new Date('2026-09-28'),
      },
      {
        project: seoProj._id,
        issueKey: 'NX-SEO-103',
        issueType: 'story',
        title: 'High-Authority Tier 1 Backlink Outreach Campaign',
        description: 'Acquire 15+ contextual DR 65+ guest publications and editorial citations in FinTech / Banking verticals.',
        assignedTo: userByEmail['emily.seo@neximet.com']._id,
        reporter: userByEmail['pm@neximet.com']._id,
        status: 'todo',
        priority: 'High',
        storyPoints: 8,
        labels: ['outreach', 'backlinks', 'pr'],
        order: 2,
        subtasks: [
          { title: 'Curate list of 50 vetted FinTech publishers', completed: false },
          { title: 'Draft personalized pitch templates with data infographics', completed: false },
        ],
        comments: [],
        estimatedHours: 35,
        spentHours: 0,
        deadline: new Date('2026-10-20'),
      },

      // WordPress Project Issues
      {
        project: wpProj._id,
        issueKey: 'NX-WP-101',
        issueType: 'epic',
        title: 'Custom ACF Gutenberg Blocks Architecture',
        description: 'Build 18 custom blocks tailored for luxury furniture catalog with dynamic attributes.',
        assignedTo: userByEmail['tariq.wp@neximet.com']._id,
        reporter: userByEmail['pm@neximet.com']._id,
        status: 'done',
        priority: 'High',
        storyPoints: 13,
        labels: ['wordpress', 'gutenberg', 'acf'],
        order: 0,
        subtasks: [
          { title: 'Register custom block categories', completed: true },
          { title: 'Develop React/JSX block editor preview', completed: true },
        ],
        comments: [],
        estimatedHours: 45,
        spentHours: 42,
        deadline: new Date('2026-09-02'),
      },
      {
        project: wpProj._id,
        issueKey: 'NX-WP-102',
        issueType: 'story',
        title: 'WooCommerce Headless Cart & Checkout Sync',
        description: 'Sync React frontend shopping bag with WooCommerce GraphQL mutation endpoints in real time.',
        assignedTo: userByEmail['zainab.wp@neximet.com']._id,
        reporter: userByEmail['tariq.wp@neximet.com']._id,
        status: 'in_progress',
        priority: 'Urgent',
        storyPoints: 8,
        labels: ['woocommerce', 'graphql', 'cart'],
        order: 1,
        subtasks: [
          { title: 'Test CoCart REST endpoints vs WPGraphQL', completed: true },
          { title: 'Session persistence across custom domain redirects', completed: false },
        ],
        comments: [],
        estimatedHours: 30,
        spentHours: 18,
        deadline: new Date('2026-09-26'),
      },
      {
        project: wpProj._id,
        issueKey: 'NX-WP-103',
        issueType: 'bug',
        title: 'Stripe Webhook signature mismatch on currency conversion',
        description: 'When customer pays in EUR, Stripe webhook signature fails validation due to payload raw buffer decoding.',
        assignedTo: userByEmail['zainab.wp@neximet.com']._id,
        reporter: userByEmail['pm@neximet.com']._id,
        status: 'review',
        priority: 'High',
        storyPoints: 3,
        labels: ['bug', 'stripe', 'payments'],
        order: 2,
        subtasks: [
          { title: 'Capture raw body buffer in express middleware before bodyParser', completed: true },
        ],
        comments: [],
        estimatedHours: 8,
        spentHours: 6,
        deadline: new Date('2026-09-20'),
      },
    ];

    const createdTasks = [];
    for (const t of tasksToCreate) {
      const taskDoc = new Task(t);
      await taskDoc.save();
      createdTasks.push(taskDoc);
    }
    console.log(`Seeded ${createdTasks.length} rich Jira issues with subtasks and comments.`);

    // Seed TimeLogs linking to tasks
    await TimeLog.create([
      {
        project: aiProj._id,
        task: createdTasks[0]._id,
        user: userByEmail['marcus.dev@neximet.com']._id,
        hours: 7.5,
        description: 'Engineered batch embeddings queue with rate-limit retries',
        billable: true,
        date: new Date('2026-08-15'),
      },
      {
        project: aiProj._id,
        task: createdTasks[1]._id,
        user: userByEmail['bilal.dev@neximet.com']._id,
        hours: 6.0,
        description: 'Implemented LangGraph supervisor agent decision branches',
        billable: true,
        date: new Date('2026-09-16'),
      },
      {
        project: wpProj._id,
        task: createdTasks[9]._id,
        user: userByEmail['zainab.wp@neximet.com']._id,
        hours: 4.5,
        description: 'Debugged Stripe webhook raw buffer verification',
        billable: true,
        date: new Date('2026-09-17'),
      },
    ]);
    console.log('Seeded tasks and time logs.');

    // 5. Seed Attendance with Realistic Scenarios (On-time, Late with Deduction, Half-day)
    const today = new Date();
    const formatDateStr = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Attendance for today
    const todayStr = formatDateStr(today);

    // Marcus Chen - On-Time Check-In (08:52 AM)
    const marcusCheckIn = new Date(today);
    marcusCheckIn.setHours(8, 52, 0, 0);
    await Attendance.create({
      user: userByEmail['marcus.dev@neximet.com']._id,
      date: todayStr,
      checkIn: marcusCheckIn,
      status: 'present',
      isLate: false,
      minutesLate: 0,
      deductionAmount: 0,
      deductionPercentage: 0,
      deductionReason: 'Checked in on time (08:52 AM)',
    });

    // Emily Watson - Grace Period Check-In (09:12 AM, grace is 15m)
    const emilyCheckIn = new Date(today);
    emilyCheckIn.setHours(9, 12, 0, 0);
    await Attendance.create({
      user: userByEmail['emily.seo@neximet.com']._id,
      date: todayStr,
      checkIn: emilyCheckIn,
      status: 'present',
      isLate: false,
      minutesLate: 12,
      deductionAmount: 0,
      deductionPercentage: 0,
      deductionReason: 'Arrival within 15 mins grace window (12m late). No deduction applied.',
    });

    // Bilal Khan - Late Check-In (09:38 AM -> 38 mins late, 5% deduction of daily wage PKR 4,667 = PKR 233)
    const bilalCheckIn = new Date(today);
    bilalCheckIn.setHours(9, 38, 0, 0);
    await Attendance.create({
      user: userByEmail['bilal.dev@neximet.com']._id,
      date: todayStr,
      checkIn: bilalCheckIn,
      status: 'late',
      isLate: true,
      minutesLate: 38,
      deductionAmount: 233,
      deductionPercentage: 5,
      deductionReason: 'Late by 38 mins (exceeded 15m grace -> 5% daily wage deduction of PKR 4,667 = PKR 233)',
    });

    // Zainab Malik - Half-Day Late (10:15 AM -> 75 mins late -> 50% deduction of daily wage PKR 4167 = PKR 2084)
    const zainabCheckIn = new Date(today);
    zainabCheckIn.setHours(10, 15, 0, 0);
    await Attendance.create({
      user: userByEmail['zainab.wp@neximet.com']._id,
      date: todayStr,
      checkIn: zainabCheckIn,
      status: 'half_day',
      isLate: true,
      minutesLate: 75,
      deductionAmount: 2084,
      deductionPercentage: 50,
      deductionReason: 'Late by 75 mins (exceeded 60m threshold -> Half-Day 50% wage deduction of PKR 4,167 = PKR 2,084)',
    });

    // Also add historical records for the past few days to show robust charts & deduction reports
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayStr = formatDateStr(yesterday);

    await Attendance.create([
      {
        user: userByEmail['bilal.dev@neximet.com']._id,
        date: yesterdayStr,
        checkIn: new Date(new Date(yesterday).setHours(9, 45, 0)),
        checkOut: new Date(new Date(yesterday).setHours(18, 0, 0)),
        totalWorkHours: 8.25,
        status: 'late',
        isLate: true,
        minutesLate: 45,
        deductionAmount: 233,
        deductionPercentage: 5,
        deductionReason: 'Late by 45 mins -> 5% daily wage deduction (PKR 233)',
      },
      {
        user: userByEmail['chloe.seo@neximet.com']._id,
        date: yesterdayStr,
        checkIn: new Date(new Date(yesterday).setHours(8, 55, 0)),
        checkOut: new Date(new Date(yesterday).setHours(18, 5, 0)),
        totalWorkHours: 9.1,
        status: 'present',
        isLate: false,
        minutesLate: 0,
        deductionAmount: 0,
      },
    ]);
    console.log('Seeded realistic attendance records and deductions.');

    // 6. Seed Holidays & Leave Requests
    await Holiday.create([
      { title: "New Year's Day", date: new Date('2026-01-01'), description: 'Official Global Holiday', isMandatory: true, year: 2026 },
      { title: 'Eid-ul-Fitr Observance', date: new Date('2026-03-21'), description: 'Company Holiday & Long Weekend', isMandatory: true, year: 2026 },
      { title: 'International Labor Day', date: new Date('2026-05-01'), description: 'Global Workers Holiday', isMandatory: true, year: 2026 },
      { title: 'Independence Day', date: new Date('2026-08-14'), description: 'National Holiday', isMandatory: true, year: 2026 },
      { title: 'Neximet Annual Innovation Day', date: new Date('2026-10-12'), description: 'Company Hackathon & Team Celebration', isMandatory: true, year: 2026 },
      { title: 'Year-End Winter Break', date: new Date('2026-12-25'), description: 'Christmas & Winter Holiday', isMandatory: true, year: 2026 },
    ]);

    await LeaveRequest.create([
      {
        user: userByEmail['bilal.dev@neximet.com']._id,
        leaveType: 'casual',
        startDate: new Date('2026-09-28'),
        endDate: new Date('2026-09-29'),
        totalDays: 2,
        reason: 'Family wedding event out of town',
        status: 'pending',
      },
      {
        user: userByEmail['leo.design@neximet.com']._id,
        leaveType: 'sick',
        startDate: new Date('2026-09-10'),
        endDate: new Date('2026-09-11'),
        totalDays: 2,
        reason: 'Seasonal flu recovery',
        status: 'approved',
        reviewedBy: userByEmail['sofia.design@neximet.com']._id,
        reviewComments: 'Approved, get well soon!',
      },
    ]);
    console.log('Seeded holidays and leave requests.');

    console.log('\n--- SEEDING COMPLETED SUCCESSFULLY ---');
    console.log('Default Accounts:');
    console.log('CEO:            ceo@neximet.com       / password123');
    console.log('Project Mgr:    pm@neximet.com        / password123');
    console.log('Team Mgr (Dev): marcus.dev@neximet.com / password123');
    console.log('Team Member:    bilal.dev@neximet.com  / password123');
    console.log('-------------------------------------\n');

    process.exit(0);
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  }
};

seedDatabase();
