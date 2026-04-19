'use strict';
/**
 * Seed script — inserts employees, projects, and SOP tasks
 * Run AFTER migrate.js: node scripts/seed.js
 * Safe to re-run — uses ON CONFLICT DO NOTHING / DO UPDATE
 */
require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const logger   = require('../src/utils/logger');

const needsSsl = (process.env.DATABASE_URL || '').includes('sslmode=require');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

// ── EMPLOYEES (from WhatsApp sheet + Code.gs EMPLOYEES map) ──
const EMPLOYEES = [
  { name:'Anik Deb',                      email:'anik.deb@mysanmar.com',           password:'anik7421',       phone:'8801332523559',  role:'employee',    dept:'BD',              has_meeting:false },
  { name:'Arup Kumar Nag',                email:'arup.nag@mysanmar.com',            password:'arup5839',       phone:'8801713376417',  role:'employee',    dept:'CSD',             has_meeting:false },
  { name:'Ateshin Ruksha',                email:'ateshin.rukhsha@mysanmar.com',     password:'ateshin6612',    phone:'8801708135015',  role:'employee',    dept:'PDDMI',           has_meeting:false },
  { name:'Khandakar Ahsanuzzaman',        email:'ahsanuzzaman@mysanmar.com',        password:'ahsan9047',      phone:'8801755644531',  role:'employee',    dept:'BPC',             has_meeting:false },
  { name:'Lt. Col. Abdullah Ibn Zaid',    email:'abdullah.zaid@mysanmar.com',       password:'zaid7715',       phone:'8801332811858',  role:'employee',    dept:'General',         has_meeting:false },
  { name:'Mahmudur Rahman',               email:'mahmudurrahman@mysanmar.com',      password:'mahmud6284',     phone:'8801713376408',  role:'employee',    dept:'PMED',            has_meeting:false },
  { name:'Moin Azamay',                   email:'moin.azamay@mysanmar.com',         password:'moin5593',       phone:null,             role:'employee',    dept:'General',         has_meeting:false },
  { name:'Md. Golam Kibria',              email:'kibria@mysanmar.com',              password:'kibria8426',     phone:'8801713376344',  role:'employee',    dept:'P&P',             has_meeting:false },
  { name:'Md. Naziul Islam',              email:'naziul.islam@mysanmar.com',        password:'naziul3748',     phone:'8801769969689',  role:'employee',    dept:'P&P',             has_meeting:false },
  { name:'Md. Nazrul Islam Khan',         email:'nazrulislam.khan@mysanmar.com',    password:'nazrul6931',     phone:'8801713248767',  role:'employee',    dept:'General',         has_meeting:false },
  { name:'Md. Shoeb Al Rahe',             email:'shoeb.alrahe@mysanmar.com',        password:'shoeb8152',      phone:'8801755644548',  role:'lead',        dept:'PDDM',            has_meeting:true  },
  { name:'Md. Monir Hasan',               email:'monir.hasan@mysanmar.com',         password:'zahid4706',      phone:'8801708135030',  role:'lead',        dept:'PDDM',            has_meeting:true  },
  { name:'Md. Zahidur Islam',             email:'zahidul.islam@mysanmar.com',       password:'zahidul9521',    phone:'8801755644684',  role:'employee',    dept:'P&P',             has_meeting:false },
  { name:'Mohammad Mainul Hoque',         email:'mainul@mysanmar.com',              password:'mainul3187',     phone:'8801755644500',  role:'employee',    dept:'External Affair', has_meeting:false },
  { name:'Pritha Parmita Roy',            email:'pritha.parmita@mysanmar.com',      password:'pritha6249',     phone:'8801332523580',  role:'employee',    dept:'External Affair', has_meeting:false },
  { name:'Shaikh Mehedi Hasan',           email:'hasan.mehedi@mysanmar.com',        password:'mehedi7364',     phone:'8801708150735',  role:'employee',    dept:'B&M',             has_meeting:false },
  { name:'Saleem Bin Saleh',              email:'saleembs@mysanmar.com',            password:'saleem5842',     phone:'8801713376364',  role:'employee',    dept:'BD',              has_meeting:false },
  { name:'Snahashis Dey',                 email:'snahashis@mysanmar.com',           password:'snahashis9135',  phone:'8801755644607',  role:'employee',    dept:'Structure-PDDM',  has_meeting:false },
  { name:'Subrata Sen',                   email:'subrata.sen@mysanmar.com',         password:'subrata4673',    phone:'8801713376308',  role:'employee',    dept:'General',         has_meeting:false },
  { name:'Sheikh Seraj',                  email:'sheikh.seraj@mysanmar.com',        password:'seraj8516',      phone:null,             role:'employee',    dept:'General',         has_meeting:false },
  { name:'Mashuk Huck',                   email:'mashuk@mysanmar.com',              password:'mashuk2684',     phone:'971568847374',   role:'employee',    dept:'General',         has_meeting:false },
  { name:'Atika Huq',                     email:'atika@mysanmar.com',               password:'atika5317',      phone:'8801730334466',  role:'employee',    dept:'General',         has_meeting:false },
  { name:'Shourov Ahmed',                 email:'shourov.ahmed@mysanmar.com',       password:'shourov6498',    phone:'8801755644578',  role:'employee',    dept:'B&M',             has_meeting:false },
  { name:'Andalib Rahman',                email:'andalib.rahman@mysanmar.com',      password:'andalib1135',    phone:null,             role:'employee',    dept:'B&M',             has_meeting:false },
  { name:'Dewan Shamsul Arafin',          email:'shamshull.arafien@mysanmar.com',   password:'arefin1323',     phone:'8801708150716',  role:'employee',    dept:'MEP',             has_meeting:false },
  { name:'Shafkat Islam',                 email:'shafkat.islam@mysanmar.com',       password:'shafkat321',     phone:'8801755644587',  role:'employee',    dept:'Structure-PDDM',  has_meeting:false },
  { name:'Md. Nuruzzaman',                email:'nuruzzaman@mysanmar.com',          password:'nuruzzaman5432', phone:'8801713376381',  role:'employee',    dept:'General',         has_meeting:false },
  { name:'Md. Altaf Hossain',             email:'altaf.hossain@mysanmar.com',       password:'altaf1155',      phone:'8801713376382',  role:'employee',    dept:'General',         has_meeting:false },
  // Admin accounts
  { name:'Portal Admin',                  email:'projects.sanmar@gmail.com',        password:'sanmar123',      phone:null,             role:'admin',       dept:'Admin',           has_meeting:true  },
  { name:'Portal Admin 2',                email:'admin2.sanmar@gmail.com',          password:'sanmar_admin2',  phone:null,             role:'admin',       dept:'Admin',           has_meeting:true  },
  { name:'Management View 1',             email:'management1.sanmar@gmail.com',     password:'mgmt_view_2024', phone:null,             role:'management',  dept:'Management',      has_meeting:true  },
  { name:'Management View 2',             email:'management2.sanmar@gmail.com',     password:'mgmt_view_2025', phone:null,             role:'management',  dept:'Management',      has_meeting:true  },
];

// ── PROJECTS (from spreadsheet sheet names) ──
const PROJECTS = [
  { name:'AYUB CENTER',                    project_type:'SPP',       authority:'CDA',   display_order:1  },
  { name:'BELLA VISTA',                    project_type:'Non SPP',   authority:null,    display_order:2  },
  { name:'CITY CENTER - MALL',             project_type:'SPP',       authority:'CDA',   display_order:3  },
  { name:'GRANDE',                         project_type:'Other',     authority:null,    display_order:4  },
  { name:'GREEN PARK - EXTENSION',         project_type:'SPP',       authority:'CDA',   display_order:5  },
  { name:'ICON SANMAR',                    project_type:'SPP',       authority:'CDA',   display_order:6  },
  { name:'IR CENTER',                      project_type:'SPP',       authority:'CDA',   display_order:7  },
  { name:'MANSUR MANSION',                 project_type:'Non SPP',   authority:null,    display_order:8  },
  { name:'NEXUS',                          project_type:'SPP',       authority:'CDA',   display_order:9  },
  { name:'NIZAM HEIGHTS',                  project_type:'Non SPP',   authority:null,    display_order:10 },
  { name:'NO. 14',                         project_type:'Other',     authority:null,    display_order:11 },
  { name:'OMIO',                           project_type:'Non SPP',   authority:null,    display_order:12 },
  { name:'P. PALADIUM',                    project_type:'SPP',       authority:'CDA',   display_order:13 },
  { name:'PARAMOUNT TOWER',               project_type:'SPP',       authority:'CDA',   display_order:14 },
  { name:'PAVILION',                       project_type:'Non SPP',   authority:null,    display_order:15 },
  { name:'RAOZAN PROJECT',                 project_type:'Other',     authority:null,    display_order:16 },
  { name:'SERENE RIVIERA (KNIGHTS BRIDGE)',project_type:'Non SPP',   authority:'COXDA', display_order:17 },
  { name:'SQUARE',                         project_type:'SPP',       authority:'CDA',   display_order:18 },
  { name:'VIOLA',                          project_type:'Non SPP',   authority:null,    display_order:19 },
];

// ── SOP TASKS (all 70 from spreadsheet) ──
const SOP_TASKS = [
  { code:'T-01', name:'Business Development - Full Launch', dept:'BD', spp:1, nonspp:1, large:1, dep:null },
  { code:'T-02', name:'Billboard - For Land Demarcation (Structure and Branding)', dept:'B&M', spp:7, nonspp:7, large:10, dep:'T-01' },
  { code:'T-03', name:'In-house Architect Site Visit', dept:'PDDM', spp:3, nonspp:3, large:3, dep:'T-01' },
  { code:'T-04', name:'Pre Soil Test (Lower Scale)', dept:'Structure - PDDM', spp:7, nonspp:7, large:7, dep:'T-01' },
  { code:'T-05', name:'Selection of Architecture Consultant', dept:'PDDM', spp:2, nonspp:2, large:2, dep:'T-01' },
  { code:'T-06', name:'Selection of Structural Consultant', dept:'Structure - PDDM', spp:2, nonspp:2, large:2, dep:'T-01' },
  { code:'T-07', name:'Selection of MEP Consultant', dept:'MEP', spp:2, nonspp:2, large:2, dep:'T-01' },
  { code:'T-08', name:'Selection of Interior Consultants (As per CM decision)', dept:'PDDMI', spp:2, nonspp:2, large:2, dep:'T-01' },
  { code:'T-09', name:'Material Specifications', dept:'BPC', spp:4, nonspp:4, large:6, dep:'T-01' },
  { code:'T-10', name:'Initial Project Brief by PDDM', dept:'PDDM', spp:6, nonspp:6, large:6, dep:'T-01' },
  { code:'T-11', name:'Prepare all documents and apply for LUC/TP', dept:'P&P', spp:7, nonspp:7, large:7, dep:'T-01' },
  { code:'T-12', name:'Prepare all documents for Pre Booking', dept:'CSD', spp:15, nonspp:10, large:20, dep:'T-01' },
  { code:'T-13', name:'Agreement with Architectural Consultants', dept:'PDDM', spp:3, nonspp:3, large:3, dep:'T-05' },
  { code:'T-14', name:'Agreement with Structure Consultants', dept:'Structure - PMED', spp:3, nonspp:3, large:3, dep:'T-06' },
  { code:'T-15', name:'Agreement with MEP Consultants', dept:'MEP', spp:3, nonspp:3, large:3, dep:'T-07' },
  { code:'T-16', name:'Agreement with Interior Design Consultants', dept:'PDDMI', spp:3, nonspp:3, large:3, dep:'T-08' },
  { code:'T-17', name:'Site Visit with Consultants', dept:'PDDM', spp:6, nonspp:6, large:6, dep:'T-13' },
  { code:'T-18', name:'Site Visit Report', dept:'PDDM', spp:3, nonspp:3, large:3, dep:'T-17' },
  { code:'T-19', name:'Architectural Consultant Site analysis incl. FAR & Brief', dept:'PDDM', spp:6, nonspp:6, large:6, dep:'T-17' },
  { code:'T-20', name:'LUC Approval', dept:'P&P', spp:45, nonspp:45, large:45, dep:'T-11' },
  { code:'T-21', name:'NOC - Civil Aviation Clearance & Others (If Needed)', dept:'External Affair', spp:30, nonspp:30, large:30, dep:'T-11' },
  { code:'T-22', name:'NOC - Environment Department', dept:'External Affair', spp:60, nonspp:60, large:60, dep:'T-11' },
  { code:'T-23', name:'Fire Service & Civil Defense Approval', dept:'MEP', spp:60, nonspp:60, large:60, dep:'T-15' },
  { code:'T-24', name:'Final Project Brief for consultant', dept:'PDDM', spp:2, nonspp:2, large:2, dep:'T-19' },
  { code:'T-25', name:'Project Brief Approval by CM', dept:'PDDM', spp:2, nonspp:2, large:2, dep:'T-24' },
  { code:'T-26', name:'1st Phase: Preliminary Conceptual Layout (CD/SD/DD) After LUC', dept:'PDDM', spp:30, nonspp:30, large:30, dep:'T-20' },
  { code:'T-27', name:'1st Phase: Design Feedback on Conceptual Layout', dept:'PDDM', spp:4, nonspp:4, large:4, dep:'T-26' },
  { code:'T-28', name:'2nd Phase: Revised Layout by Consultants', dept:'PDDM', spp:14, nonspp:14, large:14, dep:'T-27' },
  { code:'T-29', name:'2nd Phase: Design Feedback on Revised Layout', dept:'PDDM', spp:4, nonspp:4, large:4, dep:'T-28' },
  { code:'T-30', name:'3rd Phase: Revised Layout with Primary 3D Perspective View', dept:'PDDM', spp:14, nonspp:14, large:14, dep:'T-29' },
  { code:'T-31', name:'Land Owner Approval on Layout & Primary 3D View (CM authorised)', dept:'BD', spp:7, nonspp:7, large:7, dep:'T-30' },
  { code:'T-32', name:'Project Hoarding Layout', dept:'PDDM', spp:6, nonspp:6, large:6, dep:'T-31' },
  { code:'T-33', name:'Project Kick off Meeting with Architectural consultant', dept:'PDDM', spp:4, nonspp:4, large:4, dep:'T-13' },
  { code:'T-34', name:'Project Kick off Meeting with Structural consultant', dept:'Structure - PMED', spp:4, nonspp:4, large:4, dep:'T-14' },
  { code:'T-35', name:'Project Kick off Meeting with MEP consultant', dept:'MEP', spp:4, nonspp:4, large:4, dep:'T-15' },
  { code:'T-36', name:'Project Kick off Meeting with Interior design consultant', dept:'PDDMI', spp:4, nonspp:4, large:4, dep:'T-16' },
  { code:'T-37', name:'Final Architectural Layout with 3D Perspective View by Consultant', dept:'PDDM', spp:14, nonspp:14, large:14, dep:'T-33' },
  { code:'T-38', name:'Final Architectural Presentation by Consultant', dept:'PDDM', spp:2, nonspp:2, large:2, dep:'T-37' },
  { code:'T-39', name:'Final Architectural Layout & 3D Approval By CM', dept:'PDDM', spp:3, nonspp:3, large:3, dep:'T-38' },
  { code:'T-40', name:'Elevation Face Lifting of the Project (If Needed)', dept:'PDDM', spp:30, nonspp:30, large:30, dep:'T-39' },
  { code:'T-41', name:'Area Calculation', dept:'PDDM', spp:6, nonspp:6, large:6, dep:'T-39' },
  { code:'T-42', name:'Final Fact Sheet & Pricing - CM Approved', dept:'BPC', spp:6, nonspp:6, large:6, dep:'T-41' },
  { code:'T-43', name:'PDDM Presentation for Brand & Marketing Launch', dept:'PDDM', spp:7, nonspp:7, large:7, dep:'T-42' },
  { code:'T-44', name:'Pre-Launches & Handover Layout to Sales by PDDM', dept:'PDDM', spp:1, nonspp:1, large:1, dep:'T-43' },
  { code:'T-45', name:'Drawing Preparation for Authority Approval', dept:'PDDM', spp:15, nonspp:10, large:15, dep:'T-39' },
  { code:'T-46', name:'Special Committee Approval for SPP', dept:'P&P', spp:60, nonspp:null, large:60, dep:'T-45' },
  { code:'T-47', name:'CDA/RAJUK/Building Construction 1996 Rules/COXDA Approval', dept:'P&P', spp:60, nonspp:60, large:60, dep:'T-45' },
  { code:'T-48', name:'Utility Connection - Water, Electricity', dept:'External Affair', spp:7, nonspp:7, large:7, dep:'T-47' },
  { code:'T-49', name:'Final Allotment documentation', dept:'CSD', spp:20, nonspp:15, large:20, dep:'T-42' },
  { code:'T-50', name:'Supplementary Agreement with Land Owner', dept:'BD', spp:30, nonspp:25, large:30, dep:'T-31' },
  { code:'T-51', name:'Site possession & Vacant as per Agreement and CM Decision', dept:'BD', spp:null, nonspp:null, large:null, dep:'T-50' },
  { code:'T-52', name:'Marketing Full Launch', dept:'B&M', spp:3, nonspp:3, large:3, dep:'T-44' },
  { code:'T-53', name:'Coordination Meeting with All Consultant (Structure/MEP/Fire/Interior)', dept:'PDDM', spp:3, nonspp:3, large:3, dep:'T-36' },
  { code:'T-54', name:'Site Soil Test & Report (After Demolishing)', dept:'Structure - PDDM', spp:30, nonspp:25, large:30, dep:'T-51' },
  { code:'T-55', name:'Site Mobilization - Fencing, Labour shed, Security Room, Toilet', dept:'Structure - PDDM', spp:15, nonspp:10, large:15, dep:'T-51' },
  { code:'T-56', name:'Hoarding & Structural Framework', dept:'PMED', spp:20, nonspp:15, large:20, dep:'T-55' },
  { code:'T-57', name:'Hoarding - Branding', dept:'B&M', spp:10, nonspp:7, large:10, dep:'T-56' },
  { code:'T-58', name:'Project Construction Drawings - Architecture', dept:'PDDM', spp:60, nonspp:60, large:60, dep:'T-47' },
  { code:'T-59', name:'Project Construction Drawings - Structural', dept:'Structure - PDDM', spp:50, nonspp:40, large:50, dep:'T-47' },
  { code:'T-60', name:'Project Construction Drawings - MEP & Fire', dept:'MEP', spp:50, nonspp:40, large:50, dep:'T-47' },
  { code:'T-61', name:'Project Construction Drawings - Interior', dept:'PDDMI', spp:50, nonspp:40, large:50, dep:'T-47' },
  { code:'T-62', name:'Observation/Feedback on received Drawings by PMED', dept:'PMED', spp:14, nonspp:14, large:14, dep:'T-58' },
  { code:'T-63', name:'Prepare Final Drawings (GFC) for Architecture', dept:'PDDM', spp:14, nonspp:14, large:14, dep:'T-62' },
  { code:'T-64', name:'Prepare Final Drawings (GFC) for Structure', dept:'Structure - PDDM', spp:14, nonspp:14, large:14, dep:'T-62' },
  { code:'T-65', name:'Prepare Final Drawings (GFC) for MEP & Fire', dept:'MEP', spp:14, nonspp:14, large:14, dep:'T-62' },
  { code:'T-66', name:'Prepare Final Drawings (GFC) for Interior Design', dept:'PDDMI', spp:14, nonspp:14, large:14, dep:'T-62' },
  { code:'T-67', name:'Final Review on drawing before Submission to Authority', dept:'PDDM', spp:7, nonspp:7, large:7, dep:'T-63' },
  { code:'T-68', name:'Project Budget', dept:'BPC', spp:4, nonspp:4, large:4, dep:'T-42' },
  { code:'T-69', name:'Final Technical Launch', dept:'PDDM', spp:3, nonspp:3, large:3, dep:'T-67' },
  { code:'T-70', name:'Initiate Construction', dept:'PMED', spp:7, nonspp:7, large:7, dep:'T-69' },
];

async function seed() {
  const client = await pool.connect();
  try {
    logger.info('Seeding database...');
    await client.query('BEGIN');

    // ── Users ──
    logger.info(`Inserting ${EMPLOYEES.length} users...`);
    for (const emp of EMPLOYEES) {
      const hash = await bcrypt.hash(emp.password, 10);
      await client.query(`
        INSERT INTO users (name, email, password_hash, role, phone, department, is_active, has_meeting)
        VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7)
        ON CONFLICT (email) DO UPDATE SET
          name          = EXCLUDED.name,
          password_hash = EXCLUDED.password_hash,
          role          = EXCLUDED.role,
          phone         = EXCLUDED.phone,
          department    = EXCLUDED.department,
          has_meeting   = EXCLUDED.has_meeting
      `, [emp.name, emp.email, hash, emp.role, emp.phone, emp.dept, emp.has_meeting]);
    }
    logger.info('Users seeded.');

    // ── Projects ──
    logger.info(`Inserting ${PROJECTS.length} projects...`);
    for (const proj of PROJECTS) {
      await client.query(`
        INSERT INTO projects (name, project_type, authority, display_order)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (name) DO UPDATE SET
          project_type  = EXCLUDED.project_type,
          authority     = EXCLUDED.authority,
          display_order = EXCLUDED.display_order
      `, [proj.name, proj.project_type, proj.authority, proj.display_order]);
    }
    logger.info('Projects seeded.');

    // ── SOP Tasks ──
    logger.info(`Inserting ${SOP_TASKS.length} SOP task templates...`);
    for (let i = 0; i < SOP_TASKS.length; i++) {
      const s = SOP_TASKS[i];
      await client.query(`
        INSERT INTO sop_tasks (task_code, name, department, lead_time_spp, lead_time_nonspp, lead_time_large, dependency_code, display_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (task_code) DO UPDATE SET
          name            = EXCLUDED.name,
          department      = EXCLUDED.department,
          lead_time_spp   = EXCLUDED.lead_time_spp,
          lead_time_nonspp= EXCLUDED.lead_time_nonspp,
          lead_time_large = EXCLUDED.lead_time_large,
          dependency_code = EXCLUDED.dependency_code
      `, [s.code, s.name, s.dept, s.spp, s.nonspp, s.large, s.dep, i + 1]);
    }
    logger.info('SOP tasks seeded.');

    await client.query('COMMIT');
    logger.info('Seed complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Seed failed', { error: err.message, stack: err.stack });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
