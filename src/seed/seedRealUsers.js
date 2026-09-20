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
const connectDB = require('../config/db');

// Ensure uploads/scopes directory exists with sample files
const scopesDir = path.join(__dirname, '../../uploads/scopes');
if (!fs.existsSync(scopesDir)) {
  fs.mkdirSync(scopesDir, { recursive: true });
}

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

const seedRealDatabase = async () => {
  try {
    console.log('Connecting to MongoDB...');
    await connectDB();
    console.log('Connected to MongoDB successfully.');

    // Clear existing collections
    await User.deleteMany({});
    await Project.deleteMany({});
    await Task.deleteMany({});
    await TimeLog.deleteMany({});
    await Attendance.deleteMany({});
    await DeductionRule.deleteMany({});
    await LeaveRequest.deleteMany({});
    await Holiday.deleteMany({});
    console.log('Cleared all previous collections.');

    // 1. Define Real Users (All salaries blank: baseSalary: null, dailyWage: null; Uniform leave count: 10, 8, 14)
    const usersDefinition = [
      // CEOs (Executive)
      {
        email: 'talha@neximet.com',
        name: 'Talha bin Abdul Rehman',
        role: 'CEO',
        department: 'Executive',
        designation: 'Chief Executive Officer',
        password: 'talha@123',
        phone: '+92 (300) 111-0001',
      },
      {
        email: 'bilal@neximet.com',
        name: 'Syed Bilal Ashraf',
        role: 'CEO',
        department: 'Executive',
        designation: 'Chief Executive Officer',
        password: 'bilal@123',
        phone: '+92 (300) 111-0002',
      },

      // Software Development Team - Leadership & Trainee
      {
        email: 'jawwad@neximet.com',
        name: 'Jawwad Kareem',
        role: 'Project Manager',
        department: 'Software Development',
        designation: 'Technical Project Manager',
        password: 'jawwad@123',
        phone: '+92 (321) 222-1001',
      },
      {
        email: 'mustafa@gmail.com',
        name: 'Mustafa',
        role: 'Team Member',
        department: 'Software Development',
        designation: 'Software Engineering Trainee (Assisting PM)',
        password: 'mustafa@123',
        phone: '+92 (333) 222-1002',
      },

      // Software Development Team - Team Manager 1 (Syed Yaseen Jamal) & Subordinates
      {
        email: 'yaseen@neximet.com',
        name: 'Syed Yaseen Jamal',
        role: 'Team Manager',
        department: 'Software Development',
        designation: 'Software Development Team Manager',
        password: 'yaseen@123',
        phone: '+92 (345) 222-1003',
      },
      {
        email: 'areeba@neximet.com',
        name: 'Areeba Khan',
        role: 'Team Member',
        department: 'Software Development',
        designation: 'Software Engineer',
        password: 'areeba@123',
        phone: '+92 (312) 222-1004',
      },
      {
        email: 'ayesha@neximet.com',
        name: 'Ayesha Faheem',
        role: 'Team Member',
        department: 'Software Development',
        designation: 'Software Engineer',
        password: 'ayesha@123',
        phone: '+92 (301) 222-1005',
      },
      {
        email: 'abdul@neximet.com',
        name: 'Abdul Rehman',
        role: 'Team Member',
        department: 'Software Development',
        designation: 'Software Engineer',
        password: 'abdul@123',
        phone: '+92 (322) 222-1006',
      },

      // Software Development Team - Team Manager 2 (Abdul Ahad) & Subordinates
      {
        email: 'ahad@neximet.com',
        name: 'Abdul Ahad',
        role: 'Team Manager',
        department: 'Software Development',
        designation: 'Software Development Team Manager',
        password: 'ahad@123',
        phone: '+92 (334) 222-1007',
      },
      {
        email: 'hammad@neximet.com',
        name: 'Hammad Lodhi',
        role: 'Team Member',
        department: 'Software Development',
        designation: 'Software Engineer',
        password: 'hammad@123',
        phone: '+92 (302) 222-1008',
      },
      {
        email: 'ayla@neximet.com',
        name: 'Ayla Imran',
        role: 'Team Member',
        department: 'Software Development',
        designation: 'Software Engineer',
        password: 'ayla@123',
        phone: '+92 (313) 222-1009',
      },
      {
        email: 'ahmed@neximet.com',
        name: 'Muhammad Ahmed',
        role: 'Team Member',
        department: 'Software Development',
        designation: 'Software Engineer',
        password: 'ahmed@123',
        phone: '+92 (305) 222-1010',
      },

      // WordPress Team (No hierarchy - both are Project Managers)
      {
        email: 'abrar@neximet.com',
        name: 'Abrar Siddiqui',
        role: 'Project Manager',
        department: 'WordPress Team',
        designation: 'WordPress Project Manager',
        password: 'abrar@123',
        phone: '+92 (346) 333-2001',
      },
      {
        email: 'farhan@neximet.com',
        name: 'Farhan',
        role: 'Project Manager',
        department: 'WordPress Team',
        designation: 'WordPress Project Manager',
        password: 'farhan@123',
        phone: '+92 (323) 333-2002',
      },

      // SEO Team (No hierarchy - both are Project Managers)
      {
        email: 'ammar@neximet.com',
        name: 'Ammar Siddiqui',
        role: 'Project Manager',
        department: 'Digital Marketing (SEO)',
        designation: 'SEO Project Manager',
        password: 'ammar@123',
        phone: '+92 (335) 444-3001',
      },
      {
        email: 'jawad@neximet.com',
        name: 'Jawad',
        role: 'Project Manager',
        department: 'Digital Marketing (SEO)',
        designation: 'SEO Project Manager',
        password: 'jawad@123',
        phone: '+92 (306) 444-3002',
      },

      // Graphics Designing Team (Single member - Project Manager)
      {
        email: 'idrees@neximet.com',
        name: 'Idrees',
        role: 'Project Manager',
        department: 'Graphics Designing',
        designation: 'Graphics Project Manager',
        password: 'idrees@123',
        phone: '+92 (314) 555-4001',
      },
    ];

    // Create users initially
    const userByEmail = {};
    for (const u of usersDefinition) {
      const userDoc = new User({
        name: u.name,
        email: u.email.toLowerCase(),
        password: u.password,
        role: u.role,
        department: u.department,
        designation: u.designation,
        baseSalary: null, // Left blank for CEO to edit
        dailyWage: null,  // Left blank for CEO to edit
        phone: u.phone,
        leaveBalances: { casual: 10, sick: 8, annual: 14 }, // Same leaves count for all
        reportsTo: null,
      });
      await userDoc.save();
      userByEmail[u.email.toLowerCase()] = userDoc;
    }
    console.log(`Created ${Object.keys(userByEmail).length} users with passwords and blank salaries.`);

    // 2. Link Reporting Hierarchy (reportsTo references)
    const ceoTalhaId = userByEmail['talha@neximet.com']._id;
    const pmJawwadId = userByEmail['jawwad@neximet.com']._id;
    const tmYaseenId = userByEmail['yaseen@neximet.com']._id;
    const tmAhadId = userByEmail['ahad@neximet.com']._id;

    // Reporting links:
    const hierarchyMap = {
      'jawwad@neximet.com': ceoTalhaId,       // PM Jawwad reports to CEO
      'mustafa@gmail.com': pmJawwadId,         // Trainee directly assisting Jawwad
      'yaseen@neximet.com': pmJawwadId,        // Team Manager Yaseen reports to Jawwad
      'ahad@neximet.com': pmJawwadId,          // Team Manager Ahad reports to Jawwad
      'areeba@neximet.com': tmYaseenId,        // Areeba reports to Yaseen
      'ayesha@neximet.com': tmYaseenId,        // Ayesha reports to Yaseen
      'abdul@neximet.com': tmYaseenId,         // Abdul reports to Yaseen
      'hammad@neximet.com': tmAhadId,          // Hammad reports to Ahad
      'ayla@neximet.com': tmAhadId,            // Ayla reports to Ahad
      'ahmed@neximet.com': tmAhadId,           // Ahmed reports to Ahad
      'abrar@neximet.com': ceoTalhaId,         // WordPress PM reports to CEO
      'farhan@neximet.com': ceoTalhaId,        // WordPress PM reports to CEO
      'ammar@neximet.com': ceoTalhaId,         // SEO PM reports to CEO
      'jawad@neximet.com': ceoTalhaId,         // SEO PM reports to CEO
      'idrees@neximet.com': ceoTalhaId,        // Graphics Designer reports to CEO
    };

    for (const [email, managerId] of Object.entries(hierarchyMap)) {
      await User.updateOne({ email }, { $set: { reportsTo: managerId } });
    }
    console.log('Linked all reporting manager relationships.');

    // 3. Seed Deduction Policy
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
      officeLocation: {
        officeAddress: 'Neximet Head Office, Karachi',
        latitude: 24.8607,
        longitude: 67.0011,
        radiusMeters: 200,
        enforceLocation: true,
      },
      isActive: true,
      updatedBy: ceoTalhaId,
    });
    await deductionRule.save();
    console.log('Seeded Deduction Policy.');

    // 4. Seed Projects Assigned to Real Teams
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
        projectManager: userByEmail['jawwad@neximet.com']._id,
        scopeDocument: {
          fileName: 'NX-AI-01-scope-spec.pdf',
          originalName: 'Apex-AgenticAI-Scope-Specification-v2.pdf',
          fileUrl: '/uploads/scopes/NX-AI-01-scope-spec.pdf',
          fileType: 'application/pdf',
          fileSize: 4200000,
          summary: 'Detailed system architecture specification: LLM routing orchestration, LangGraph DAGs, and SLA guarantees.',
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
            notes: 'Production vector search index holding medical document embeddings',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager'],
          },
        ],
        milestones: [
          { title: 'Phase 1: Architecture & Vector Pipeline', deadline: new Date('2026-08-20'), status: 'completed', progress: 100 },
          { title: 'Phase 2: Autonomous Agent Tools & Webhook Bridge', deadline: new Date('2026-09-25'), status: 'in_progress', progress: 75 },
          { title: 'Phase 3: Load Testing & Security Audit', deadline: new Date('2026-10-15'), status: 'pending', progress: 10 },
          { title: 'Phase 4: Client Production Cutover', deadline: new Date('2026-10-30'), status: 'pending', progress: 0 },
        ],
        assignedMembers: [
          { user: userByEmail['jawwad@neximet.com']._id, roleInProject: 'Project Manager', allocatedHoursPerWeek: 15 },
          { user: userByEmail['yaseen@neximet.com']._id, roleInProject: 'Team Lead / Architect', allocatedHoursPerWeek: 30 },
          { user: userByEmail['areeba@neximet.com']._id, roleInProject: 'Full-Stack AI Engineer', allocatedHoursPerWeek: 35 },
          { user: userByEmail['ayesha@neximet.com']._id, roleInProject: 'Frontend Stream Specialist', allocatedHoursPerWeek: 30 },
          { user: userByEmail['mustafa@gmail.com']._id, roleInProject: 'Engineering Trainee', allocatedHoursPerWeek: 25 },
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
        projectManager: userByEmail['ammar@neximet.com']._id,
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
            usernameOrEmail: 'seo-agency@neximet.com',
            passwordOrKey: 'ahrefs_live_token_77192803',
            endpointUrl: 'https://app.ahrefs.com',
            notes: 'Agency account with unlimited domain rank tracking',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
        ],
        milestones: [
          { title: 'Audit & Crawl Error Remediation', deadline: new Date('2026-08-10'), status: 'completed', progress: 100 },
          { title: 'Topic Cluster Silo Deployment', deadline: new Date('2026-09-30'), status: 'in_progress', progress: 60 },
          { title: 'Authority Backlink Outreach Sprint', deadline: new Date('2026-10-31'), status: 'pending', progress: 0 },
        ],
        assignedMembers: [
          { user: userByEmail['ammar@neximet.com']._id, roleInProject: 'Project Manager & Lead Strategist', allocatedHoursPerWeek: 25 },
          { user: userByEmail['jawad@neximet.com']._id, roleInProject: 'Project Manager & Technical SEO Specialist', allocatedHoursPerWeek: 25 },
        ],
      },
      {
        title: 'Neximet Brand Identity & UI Design System 2026',
        code: 'NX-GD-02',
        clientName: 'Neximet Internal / Brand Lab',
        department: 'Graphics Designing',
        description: 'Comprehensive UI component library, 3D assets, vector illustration system, and marketing social kits.',
        status: 'in_progress',
        priority: 'Medium',
        completionPercentage: 78,
        startDate: new Date('2026-08-10'),
        deadline: new Date('2026-10-10'),
        budget: 1800000,
        estimatedHours: 200,
        spentHours: 155,
        projectManager: userByEmail['idrees@neximet.com']._id,
        scopeDocument: {
          fileName: 'NX-GD-02-brand-guide.pdf',
          originalName: 'Neximet-Brand-Identity-V3.pdf',
          fileUrl: '/uploads/scopes/NX-GD-02-brand-guide.pdf',
          fileType: 'application/pdf',
          fileSize: 8500000,
          summary: 'Vector assets, WCAG AAA color contrast specs, micro-interactions, and Figma master tokens.',
        },
        credentials: [
          {
            platform: 'Figma Enterprise Organization',
            environment: 'Production',
            usernameOrEmail: 'design-lead@neximet.com',
            passwordOrKey: 'figma_sso_org_access_2026',
            endpointUrl: 'https://figma.com/@neximet',
            notes: 'Contains all design libraries, components, and client deliverable files',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
        ],
        milestones: [
          { title: 'Figma Master Tokens & Typography Scale', deadline: new Date('2026-08-30'), status: 'completed', progress: 100 },
          { title: 'Interactive Web Components & Dark Mode Tokens', deadline: new Date('2026-09-22'), status: 'in_progress', progress: 85 },
          { title: 'Asset Export & Developer Hand-off', deadline: new Date('2026-10-10'), status: 'pending', progress: 20 },
        ],
        assignedMembers: [
          { user: userByEmail['idrees@neximet.com']._id, roleInProject: 'Graphics Project Manager', allocatedHoursPerWeek: 40 },
        ],
      },
      {
        title: 'Luxury Living Headless WooCommerce & ACF Blocks',
        code: 'NX-WP-08',
        clientName: 'Prestige Living Furnishings Ltd.',
        department: 'WordPress Team',
        description: 'Next.js storefront paired with headless WordPress CMS, GraphQL catalog synchronization, and Stripe checkout.',
        status: 'in_progress',
        priority: 'High',
        completionPercentage: 82,
        startDate: new Date('2026-07-20'),
        deadline: new Date('2026-09-30'),
        budget: 4200000,
        estimatedHours: 320,
        spentHours: 260,
        projectManager: userByEmail['abrar@neximet.com']._id,
        scopeDocument: {
          fileName: 'NX-WP-08-architecture.pdf',
          originalName: 'Prestige-Headless-WordPress-Architecture.pdf',
          fileUrl: '/uploads/scopes/NX-WP-08-architecture.pdf',
          fileType: 'application/pdf',
          fileSize: 2800000,
          summary: 'Schema definition for 3,500 SKU furniture variants, ACF block structures, and webhook event relays.',
        },
        credentials: [
          {
            platform: 'WP Engine Production Hosting',
            environment: 'Production',
            usernameOrEmail: 'sftp_prestige_prod',
            passwordOrKey: 'wp_sftp_sec_pass_9921820',
            endpointUrl: 'sftp://prestige.wpengine.com:2222',
            notes: 'High-availability containerized WordPress environment with Memcached',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
        ],
        milestones: [
          { title: 'ACF Flexible Gutenberg Layouts', deadline: new Date('2026-08-15'), status: 'completed', progress: 100 },
          { title: 'GraphQL Catalog & Product Variant Mutations', deadline: new Date('2026-09-10'), status: 'completed', progress: 100 },
          { title: 'Multi-Currency Stripe Webhook Pipeline', deadline: new Date('2026-09-25'), status: 'in_progress', progress: 65 },
        ],
        assignedMembers: [
          { user: userByEmail['abrar@neximet.com']._id, roleInProject: 'WordPress Project Manager', allocatedHoursPerWeek: 30 },
          { user: userByEmail['farhan@neximet.com']._id, roleInProject: 'WordPress Project Manager & Senior Developer', allocatedHoursPerWeek: 35 },
        ],
      },
      {
        title: 'High-Frequency Real-Time Streaming Ledger',
        code: 'NX-DEV-03',
        clientName: 'PayStream Financials',
        department: 'Software Development',
        description: 'Microservice data streaming pipeline, WebSocket live feeds, fraud heuristics, and audit-ready reporting.',
        status: 'in_progress',
        priority: 'Critical',
        completionPercentage: 35,
        startDate: new Date('2026-09-01'),
        deadline: new Date('2026-12-15'),
        budget: 5200000,
        estimatedHours: 380,
        spentHours: 110,
        projectManager: userByEmail['jawwad@neximet.com']._id,
        credentials: [
          {
            platform: 'Kafka Cloud Streaming Cluster',
            environment: 'Staging',
            usernameOrEmail: 'client-key-kafka-paystream',
            passwordOrKey: 'kafka_sec_tok_991823091820391820',
            endpointUrl: 'https://paystream.aws.confluent.cloud',
            notes: 'Staging event broker for processing ledger transactions',
            visibleToRoles: ['CEO', 'Project Manager', 'Team Manager', 'Team Member'],
          },
        ],
        milestones: [
          { title: 'Kafka Schema Registry & Data Models', deadline: new Date('2026-09-30'), status: 'in_progress', progress: 60 },
          { title: 'Fraud Detection Engine MVP', deadline: new Date('2026-10-30'), status: 'pending', progress: 0 },
        ],
        assignedMembers: [
          { user: userByEmail['jawwad@neximet.com']._id, roleInProject: 'Project Manager', allocatedHoursPerWeek: 15 },
          { user: userByEmail['ahad@neximet.com']._id, roleInProject: 'Backend Lead / Manager', allocatedHoursPerWeek: 30 },
          { user: userByEmail['hammad@neximet.com']._id, roleInProject: 'Distributed Systems Engineer', allocatedHoursPerWeek: 35 },
          { user: userByEmail['ayla@neximet.com']._id, roleInProject: 'Real-Time Dashboard UI Specialist', allocatedHoursPerWeek: 30 },
          { user: userByEmail['ahmed@neximet.com']._id, roleInProject: 'Data Pipeline Specialist', allocatedHoursPerWeek: 30 },
          { user: userByEmail['abdul@neximet.com']._id, roleInProject: 'Security & Microservices Engineer', allocatedHoursPerWeek: 30 },
        ],
      },
    ];

    const createdProjects = [];
    for (const p of projectsData) {
      const projDoc = new Project(p);
      await projDoc.save();
      createdProjects.push(projDoc);
    }
    console.log(`Seeded ${createdProjects.length} projects.`);

    // 5. Seed Tasks / Jira Issues Assigned to Real Team Members
    const aiProj = createdProjects[0];
    const seoProj = createdProjects[1];
    const gdProj = createdProjects[2];
    const wpProj = createdProjects[3];
    const devProj = createdProjects[4];

    const tasksToCreate = [
      // Software Dev Team 1 (Yaseen, Areeba, Ayesha, Mustafa)
      {
        project: aiProj._id,
        issueKey: 'NX-AI-101',
        issueType: 'epic',
        title: 'Core RAG Architecture & Vector Indexing',
        description: 'End-to-end vector embedding pipeline with semantic retrieval benchmarks.',
        assignedTo: userByEmail['areeba@neximet.com']._id,
        reporter: userByEmail['yaseen@neximet.com']._id,
        status: 'done',
        priority: 'High',
        storyPoints: 13,
        labels: ['ai', 'backend', 'architecture'],
        order: 0,
        subtasks: [
          { title: 'Evaluate Pinecone vs Weaviate benchmarks', completed: true },
          { title: 'Implement chunking algorithm with 20% overlap', completed: true },
        ],
        comments: [
          { user: userByEmail['yaseen@neximet.com']._id, text: 'Pinecone serverless index configured in us-east-1.' },
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
        description: 'Implement LangGraph supervisor pattern to route triage between booking and verification agents.',
        assignedTo: userByEmail['areeba@neximet.com']._id,
        reporter: userByEmail['jawwad@neximet.com']._id,
        status: 'in_progress',
        priority: 'Urgent',
        storyPoints: 8,
        labels: ['agents', 'langgraph', 'routing'],
        order: 1,
        subtasks: [
          { title: 'Define LangGraph state schema', completed: true },
          { title: 'Connect appointment calendar integration', completed: true },
          { title: 'Unit test hallucination recovery loops', completed: false },
        ],
        comments: [
          { user: userByEmail['jawwad@neximet.com']._id, text: 'Ensure calendar API handles collision errors gracefully.' },
          { user: userByEmail['areeba@neximet.com']._id, text: 'Added backoff and conflict retry handling.' },
        ],
        estimatedHours: 32,
        spentHours: 22,
        deadline: new Date('2026-09-24'),
      },
      {
        project: aiProj._id,
        issueKey: 'NX-AI-103',
        issueType: 'task',
        title: 'Streaming SSE Response Gateway for Portal Client',
        description: 'Expose Server-Sent Events stream from backend to Next.js dashboard.',
        assignedTo: userByEmail['ayesha@neximet.com']._id,
        reporter: userByEmail['yaseen@neximet.com']._id,
        status: 'review',
        priority: 'High',
        storyPoints: 5,
        labels: ['sse', 'frontend', 'streaming'],
        order: 2,
        subtasks: [
          { title: 'Implement SSE generator endpoint', completed: true },
          { title: 'Format token chunks as JSON protocol', completed: true },
        ],
        comments: [
          { user: userByEmail['yaseen@neximet.com']._id, text: 'Reviewing frontend chunk buffer rendering.' },
        ],
        estimatedHours: 20,
        spentHours: 18,
        deadline: new Date('2026-09-21'),
      },
      {
        project: aiProj._id,
        issueKey: 'NX-AI-104',
        issueType: 'task',
        title: 'Assist Project Manager in Sprint Documentation & QA Logs',
        description: 'Prepare sprint retrospective notes, verify test coverage, and assist Jawwad Kareem with project health logs.',
        assignedTo: userByEmail['mustafa@gmail.com']._id,
        reporter: userByEmail['jawwad@neximet.com']._id,
        status: 'in_progress',
        priority: 'Medium',
        storyPoints: 3,
        labels: ['trainee', 'qa', 'documentation'],
        order: 3,
        subtasks: [
          { title: 'Compile test run results from staging', completed: true },
          { title: 'Update Jira milestone progress checklist', completed: false },
        ],
        comments: [
          { user: userByEmail['jawwad@neximet.com']._id, text: 'Good progress Mustafa, make sure QA links are attached.' },
        ],
        estimatedHours: 15,
        spentHours: 10,
        deadline: new Date('2026-09-25'),
      },

      // Software Dev Team 2 (Ahad, Hammad, Ayla, Ahmed, Abdul)
      {
        project: devProj._id,
        issueKey: 'NX-DEV-201',
        issueType: 'story',
        title: 'Kafka Consumer Group Resiliency & Rebalancing',
        description: 'Handle automatic partition failover and prevent duplicate transaction processing.',
        assignedTo: userByEmail['hammad@neximet.com']._id,
        reporter: userByEmail['ahad@neximet.com']._id,
        status: 'in_progress',
        priority: 'Urgent',
        storyPoints: 8,
        labels: ['kafka', 'streaming', 'concurrency'],
        order: 0,
        subtasks: [
          { title: 'Configure exactly-once processing semantics', completed: true },
          { title: 'Simulate broker drop and verify offset rewind', completed: false },
        ],
        comments: [
          { user: userByEmail['ahad@neximet.com']._id, text: 'Partition lag metrics are looking clean.' },
        ],
        estimatedHours: 28,
        spentHours: 16,
        deadline: new Date('2026-09-28'),
      },
      {
        project: devProj._id,
        issueKey: 'NX-DEV-202',
        issueType: 'task',
        title: 'Live WebSocket Candlestick & Ledger Dashboard',
        description: 'Build low-latency canvas rendering for high-volume transactions in the client portal.',
        assignedTo: userByEmail['ayla@neximet.com']._id,
        reporter: userByEmail['ahad@neximet.com']._id,
        status: 'in_progress',
        priority: 'High',
        storyPoints: 5,
        labels: ['ui', 'websocket', 'canvas'],
        order: 1,
        subtasks: [
          { title: 'Implement WebSocket heartbeat subscription', completed: true },
          { title: 'Virtualize ledger rows for 5,000+ items', completed: false },
        ],
        comments: [],
        estimatedHours: 24,
        spentHours: 14,
        deadline: new Date('2026-09-30'),
      },
      {
        project: devProj._id,
        issueKey: 'NX-DEV-203',
        issueType: 'story',
        title: 'PostgreSQL TimeScaleDB Partitioning & Retention',
        description: 'Partition ledger tables by day and implement automated cold-storage archiving.',
        assignedTo: userByEmail['ahmed@neximet.com']._id,
        reporter: userByEmail['ahad@neximet.com']._id,
        status: 'todo',
        priority: 'Medium',
        storyPoints: 5,
        labels: ['database', 'timescale', 'sql'],
        order: 2,
        subtasks: [
          { title: 'Define hypertables for ledger events', completed: false },
          { title: 'Setup S3 Glacier backup script', completed: false },
        ],
        comments: [],
        estimatedHours: 20,
        spentHours: 0,
        deadline: new Date('2026-10-05'),
      },
      {
        project: devProj._id,
        issueKey: 'NX-DEV-204',
        issueType: 'bug',
        title: 'JWT Secret Rotation Race Condition under Peak Concurrency',
        description: 'Expired tokens during cluster rolling deploy cause intermittent 401s on mobile clients.',
        assignedTo: userByEmail['abdul@neximet.com']._id,
        reporter: userByEmail['ahad@neximet.com']._id,
        status: 'review',
        priority: 'High',
        storyPoints: 3,
        labels: ['security', 'jwt', 'auth'],
        order: 3,
        subtasks: [
          { title: 'Add grace period dual-token validation', completed: true },
        ],
        comments: [
          { user: userByEmail['abdul@neximet.com']._id, text: 'PR opened with multi-key verifier.' },
        ],
        estimatedHours: 12,
        spentHours: 10,
        deadline: new Date('2026-09-22'),
      },

      // WordPress Team (Abrar & Farhan)
      {
        project: wpProj._id,
        issueKey: 'NX-WP-101',
        issueType: 'epic',
        title: 'ACF Gutenberg Custom Blocks Architecture',
        description: 'Build 18 custom blocks tailored for luxury furniture catalog with dynamic attributes.',
        assignedTo: userByEmail['abrar@neximet.com']._id,
        reporter: userByEmail['farhan@neximet.com']._id,
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
        title: 'Headless WooCommerce Checkout & Stripe Webhook Pipeline',
        description: 'Sync React frontend shopping cart with WooCommerce GraphQL endpoints and Stripe webhooks.',
        assignedTo: userByEmail['farhan@neximet.com']._id,
        reporter: userByEmail['abrar@neximet.com']._id,
        status: 'in_progress',
        priority: 'Urgent',
        storyPoints: 8,
        labels: ['woocommerce', 'stripe', 'graphql'],
        order: 1,
        subtasks: [
          { title: 'Test CoCart REST endpoints vs WPGraphQL', completed: true },
          { title: 'Capture raw body buffer in webhook verification', completed: true },
          { title: 'Session persistence across custom domains', completed: false },
        ],
        comments: [
          { user: userByEmail['abrar@neximet.com']._id, text: 'Raw buffer validation is passing in staging sandbox.' },
        ],
        estimatedHours: 32,
        spentHours: 24,
        deadline: new Date('2026-09-26'),
      },

      // SEO Team (Ammar & Jawad)
      {
        project: seoProj._id,
        issueKey: 'NX-SEO-101',
        issueType: 'story',
        title: 'Target Keyword Clusters & Search Intent Mapping',
        description: 'Identify 500+ commercial intent keywords for fintech payment queries.',
        assignedTo: userByEmail['ammar@neximet.com']._id,
        reporter: userByEmail['jawad@neximet.com']._id,
        status: 'done',
        priority: 'High',
        storyPoints: 8,
        labels: ['keywords', 'ahrefs', 'research'],
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
        title: 'Core Web Vitals & PageSpeed 95+ Optimization',
        description: 'Improve LCP to under 1.8s and eliminate CLS on high-converting product comparison pages.',
        assignedTo: userByEmail['jawad@neximet.com']._id,
        reporter: userByEmail['ammar@neximet.com']._id,
        status: 'in_progress',
        priority: 'High',
        storyPoints: 5,
        labels: ['technical-seo', 'core-web-vitals', 'performance'],
        order: 1,
        subtasks: [
          { title: 'Defer third-party analytics scripts', completed: true },
          { title: 'Convert hero banners to AVIF format', completed: false },
        ],
        comments: [],
        estimatedHours: 16,
        spentHours: 10,
        deadline: new Date('2026-09-28'),
      },

      // Graphics Designing Team (Idrees)
      {
        project: gdProj._id,
        issueKey: 'NX-GD-101',
        issueType: 'story',
        title: 'Enterprise Figma Tokens & Dark-Mode Design System',
        description: 'Design unified color ramps, glassmorphism card elevation styles, and responsive icon sets.',
        assignedTo: userByEmail['idrees@neximet.com']._id,
        reporter: userByEmail['jawwad@neximet.com']._id,
        status: 'in_progress',
        priority: 'High',
        storyPoints: 8,
        labels: ['figma', 'design-system', 'ui-ux'],
        order: 0,
        subtasks: [
          { title: 'Create semantic token variables in Figma', completed: true },
          { title: 'Design SVG illustration system for empty states', completed: true },
          { title: 'Export vector sprite sheet and icon components', completed: false },
        ],
        comments: [
          { user: userByEmail['idrees@neximet.com']._id, text: 'All base color tokens updated to HSL modern palette.' },
        ],
        estimatedHours: 35,
        spentHours: 28,
        deadline: new Date('2026-09-25'),
      },
    ];

    const createdTasks = [];
    for (const t of tasksToCreate) {
      const taskDoc = new Task(t);
      await taskDoc.save();
      createdTasks.push(taskDoc);
    }
    console.log(`Seeded ${createdTasks.length} rich tasks across all departments.`);

    // 6. Seed TimeLogs
    await TimeLog.create([
      {
        project: aiProj._id,
        task: createdTasks[0]._id,
        user: userByEmail['areeba@neximet.com']._id,
        hours: 7.5,
        description: 'Engineered batch embeddings queue with rate-limit retries',
        billable: true,
        date: new Date('2026-08-15'),
      },
      {
        project: aiProj._id,
        task: createdTasks[1]._id,
        user: userByEmail['areeba@neximet.com']._id,
        hours: 6.0,
        description: 'Implemented LangGraph supervisor agent decision branches',
        billable: true,
        date: new Date('2026-09-16'),
      },
      {
        project: wpProj._id,
        task: createdTasks[9]._id,
        user: userByEmail['farhan@neximet.com']._id,
        hours: 5.5,
        description: 'Debugged Stripe webhook raw buffer verification',
        billable: true,
        date: new Date('2026-09-17'),
      },
      {
        project: gdProj._id,
        task: createdTasks[12]._id,
        user: userByEmail['idrees@neximet.com']._id,
        hours: 6.5,
        description: 'Engineered responsive Figma tokens and glassmorphism styling',
        billable: true,
        date: new Date('2026-09-18'),
      },
    ]);
    console.log('Seeded time logs.');

    // 7. Seed Realistic Attendance Records
    const today = new Date();
    const formatDateStr = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    const todayStr = formatDateStr(today);

    // Jawwad Kareem (On-time)
    const jawwadCheckIn = new Date(today);
    jawwadCheckIn.setHours(8, 50, 0, 0);
    await Attendance.create({
      user: userByEmail['jawwad@neximet.com']._id,
      date: todayStr,
      checkIn: jawwadCheckIn,
      status: 'present',
      isLate: false,
      minutesLate: 0,
      deductionAmount: 0,
      deductionPercentage: 0,
      deductionReason: 'Checked in on time (08:50 AM)',
    });

    // Syed Yaseen Jamal (Grace period: 09:10 AM)
    const yaseenCheckIn = new Date(today);
    yaseenCheckIn.setHours(9, 10, 0, 0);
    await Attendance.create({
      user: userByEmail['yaseen@neximet.com']._id,
      date: todayStr,
      checkIn: yaseenCheckIn,
      status: 'present',
      isLate: false,
      minutesLate: 10,
      deductionAmount: 0,
      deductionPercentage: 0,
      deductionReason: 'Arrival within 15m grace window (10m late). No penalty.',
    });

    // Abrar Siddiqui (On-time: 08:55 AM)
    const abrarCheckIn = new Date(today);
    abrarCheckIn.setHours(8, 55, 0, 0);
    await Attendance.create({
      user: userByEmail['abrar@neximet.com']._id,
      date: todayStr,
      checkIn: abrarCheckIn,
      status: 'present',
      isLate: false,
      minutesLate: 0,
      deductionAmount: 0,
    });

    // Idrees (Late check-in: 09:35 AM)
    const idreesCheckIn = new Date(today);
    idreesCheckIn.setHours(9, 35, 0, 0);
    await Attendance.create({
      user: userByEmail['idrees@neximet.com']._id,
      date: todayStr,
      checkIn: idreesCheckIn,
      status: 'late',
      isLate: true,
      minutesLate: 35,
      deductionAmount: 0,
      deductionPercentage: 5,
      deductionReason: 'Late by 35 mins (exceeded grace period -> 5% daily wage deduction pending salary configuration)',
    });

    // 8. Seed Holidays & Leave Requests
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
        user: userByEmail['areeba@neximet.com']._id,
        leaveType: 'casual',
        startDate: new Date('2026-09-28'),
        endDate: new Date('2026-09-29'),
        totalDays: 2,
        reason: 'Family event out of town',
        status: 'pending',
      },
      {
        user: userByEmail['farhan@neximet.com']._id,
        leaveType: 'sick',
        startDate: new Date('2026-09-10'),
        endDate: new Date('2026-09-11'),
        totalDays: 2,
        reason: 'Seasonal viral flu',
        status: 'approved',
        reviewedBy: userByEmail['abrar@neximet.com']._id,
        reviewComments: 'Approved, take care and recover well!',
      },
    ]);
    console.log('Seeded holidays and leave requests.');

    console.log('\n================================================================');
    console.log('       NEXIMET REAL ORGANIZATIONAL STRUCTURE SEEDED SUCCESS     ');
    console.log('================================================================');
    console.log('CEO Accounts:');
    console.log(' - talha@neximet.com       | talha@123   (Talha bin Abdul Rehman)');
    console.log(' - bilal@neximet.com       | bilal@123   (Syed Bilal Ashraf)\n');
    console.log('Software Development Team:');
    console.log(' - jawwad@neximet.com      | jawwad@123  (Jawwad Kareem - Project Manager)');
    console.log(' - mustafa@gmail.com       | mustafa@123 (Mustafa - Trainee Assisting PM)');
    console.log(' - yaseen@neximet.com      | yaseen@123  (Syed Yaseen Jamal - Team Manager 1)');
    console.log('   * areeba@neximet.com    | areeba@123  (Areeba Khan)');
    console.log('   * ayesha@neximet.com    | ayesha@123  (Ayesha Faheem)');
    console.log('   * abdul@neximet.com     | abdul@123   (Abdul Rehman)');
    console.log(' - ahad@neximet.com        | ahad@123    (Abdul Ahad - Team Manager 2)');
    console.log('   * hammad@neximet.com    | hammad@123  (Hammad Lodhi)');
    console.log('   * ayla@neximet.com      | ayla@123    (Ayla Imran)');
    console.log('   * ahmed@neximet.com     | ahmed@123   (Muhammad Ahmed)\n');
    console.log('WordPress Team (Equal Project Managers):');
    console.log(' - abrar@neximet.com       | abrar@123   (Abrar Siddiqui)');
    console.log(' - farhan@neximet.com      | farhan@123  (Farhan)\n');
    console.log('SEO Team (Equal Project Managers):');
    console.log(' - ammar@neximet.com       | ammar@123   (Ammar Siddiqui)');
    console.log(' - jawad@neximet.com       | jawad@123   (Jawad)\n');
    console.log('Graphics Designing Team (Project Manager):');
    console.log(' - idrees@neximet.com      | idrees@123  (Idrees - Graphics Project Manager)\n');
    console.log('Configuration Notes:');
    console.log(' - Salaries: baseSalary = null, dailyWage = null (CEO will edit)');
    console.log(' - Leaves: casual: 10, sick: 8, annual: 14 (Same for all)');
    console.log('================================================================\n');

    process.exit(0);
  } catch (error) {
    console.error('Seeding real users failed:', error);
    process.exit(1);
  }
};

seedRealDatabase();
