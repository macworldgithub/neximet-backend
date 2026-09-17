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

    // 4. Seed Tasks & TimeLogs for Project 1 & 2
    const aiProj = createdProjects[0];
    const task1 = await Task.create({
      project: aiProj._id,
      title: 'Implement Vector Indexing Pipeline',
      description: 'Chunk and index medical compliance documents into Pinecone with OpenAI embeddings.',
      assignedTo: userByEmail['bilal.dev@neximet.com']._id,
      status: 'completed',
      priority: 'High',
      estimatedHours: 24,
      spentHours: 22,
      deadline: new Date('2026-08-18'),
    });

    const task2 = await Task.create({
      project: aiProj._id,
      title: 'Autonomous Multi-Agent Router & Tool Execution',
      description: 'Connect triage agent with appointment calendar API and patient notification webhooks.',
      assignedTo: userByEmail['bilal.dev@neximet.com']._id,
      status: 'in_progress',
      priority: 'Urgent',
      estimatedHours: 40,
      spentHours: 28,
      deadline: new Date('2026-09-24'),
    });

    await TimeLog.create([
      {
        project: aiProj._id,
        task: task1._id,
        user: userByEmail['bilal.dev@neximet.com']._id,
        hours: 7.5,
        description: 'Engineered batch embeddings queue with rate-limit retries',
        billable: true,
        date: new Date('2026-08-15'),
      },
      {
        project: aiProj._id,
        task: task2._id,
        user: userByEmail['bilal.dev@neximet.com']._id,
        hours: 6.0,
        description: 'Implemented LangGraph supervisor agent decision branches',
        billable: true,
        date: new Date('2026-09-16'),
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
