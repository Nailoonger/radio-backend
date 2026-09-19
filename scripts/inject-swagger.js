// 在 swagger.js MemberUpsertRequest 后插入 cadre/staff schema
const fs = require('fs');
const path = require('path');

const target = `        MemberUpsertRequest: {
          type: 'object',
          required: ['name', 'role', 'avatar'],
          properties: {
            name: { type: 'string', maxLength: 32 },
            role: { type: 'string', maxLength: 32 },
            grade: { type: 'string', maxLength: 32 },
            programs: { type: 'string', maxLength: 200 },
            avatar: { type: 'string', maxLength: 512 },
            motto: { type: 'string', maxLength: 200 },
            sort: { type: 'integer' },
            isShow: { type: 'integer', enum: [0, 1] },
          },
        },`;

const newSchemas = `
        Cadre: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            role: { type: 'string' },
            grade: { type: 'string' },
            avatar: { type: 'string' },
            motto: { type: 'string', nullable: true },
            sort: { type: 'integer' },
            isShow: { type: 'integer', enum: [0, 1] },
          },
        },
        CadreUpsertRequest: {
          type: 'object',
          required: ['name', 'role', 'avatar'],
          properties: {
            name: { type: 'string', maxLength: 32 },
            role: { type: 'string', maxLength: 32 },
            grade: { type: 'string', maxLength: 32 },
            avatar: { type: 'string', maxLength: 512 },
            motto: { type: 'string', maxLength: 200 },
            sort: { type: 'integer' },
            isShow: { type: 'integer', enum: [0, 1] },
          },
        },
        Staff: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            role: { type: 'string' },
            department: { type: 'string' },
            grade: { type: 'string' },
            programs: { type: 'string' },
            avatar: { type: 'string' },
            motto: { type: 'string', nullable: true },
            sort: { type: 'integer' },
            isShow: { type: 'integer', enum: [0, 1] },
          },
        },
        StaffUpsertRequest: {
          type: 'object',
          required: ['name', 'role', 'department', 'avatar'],
          properties: {
            name: { type: 'string', maxLength: 32 },
            role: { type: 'string', maxLength: 32 },
            department: { type: 'string', maxLength: 32 },
            grade: { type: 'string', maxLength: 32 },
            programs: { type: 'string', maxLength: 200 },
            avatar: { type: 'string', maxLength: 512 },
            motto: { type: 'string', maxLength: 200 },
            sort: { type: 'integer' },
            isShow: { type: 'integer', enum: [0, 1] },
          },
        },`;

const file = path.join(__dirname, '..', 'src', 'docs', 'swagger.js');
let content = fs.readFileSync(file, 'utf8');

if (!content.includes(target)) {
  console.error('TARGET NOT FOUND in swagger.js');
  process.exit(1);
}

const before = content.length;
content = content.replace(target, target + newSchemas);
fs.writeFileSync(file, content);

console.log(`OK: inserted 4 new schemas (${content.length - before} chars added)`);
