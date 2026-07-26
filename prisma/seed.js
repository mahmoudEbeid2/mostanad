import { prisma } from "../src/lib/prisma.js";
import bcrypt from "bcryptjs";

const permissions = [
  // Users
  { name: "Create Users", slug: "create_users", module: "users" },
  { name: "Read Users", slug: "read_users", module: "users" },
  { name: "Update Users", slug: "update_users", module: "users" },
  { name: "Delete Users", slug: "delete_users", module: "users" },

  // Roles
  { name: "Create Roles", slug: "create_roles", module: "roles" },
  { name: "Read Roles", slug: "read_roles", module: "roles" },
  { name: "Update Roles", slug: "update_roles", module: "roles" },
  { name: "Delete Roles", slug: "delete_roles", module: "roles" },

  // Companies
  { name: "Create Companies", slug: "create_companies", module: "companies" },
  { name: "Read Companies", slug: "read_companies", module: "companies" },
  { name: "Update Companies", slug: "update_companies", module: "companies" },
  { name: "Delete Companies", slug: "delete_companies", module: "companies" },

  // Plans
  { name: "Create Plans", slug: "create_plans", module: "plans" },
  { name: "Read Plans", slug: "read_plans", module: "plans" },
  { name: "Update Plans", slug: "update_plans", module: "plans" },
  { name: "Delete Plans", slug: "delete_plans", module: "plans" },

  // Subscriptions
  { name: "Create Subscriptions", slug: "create_subscriptions", module: "subscriptions" },
  { name: "Read Subscriptions", slug: "read_subscriptions", module: "subscriptions" },
  { name: "Update Subscriptions", slug: "update_subscriptions", module: "subscriptions" },
  { name: "Delete Subscriptions", slug: "delete_subscriptions", module: "subscriptions" },

  // Products
  { name: "Create Products", slug: "create_products", module: "products" },
  { name: "Read Products", slug: "read_products", module: "products" },
  { name: "Update Products", slug: "update_products", module: "products" },
  { name: "Delete Products", slug: "delete_products", module: "products" },

  // Categories
  { name: "Create Categories", slug: "create_categories", module: "categories" },
  { name: "Read Categories", slug: "read_categories", module: "categories" },
  { name: "Update Categories", slug: "update_categories", module: "categories" },
  { name: "Delete Categories", slug: "delete_categories", module: "categories" },

  // Templates
  { name: "Create Templates", slug: "create_templates", module: "templates" },
  { name: "Read Templates", slug: "read_templates", module: "templates" },
  { name: "Update Templates", slug: "update_templates", module: "templates" },
  { name: "Delete Templates", slug: "delete_templates", module: "templates" },

  // Certificates
  { name: "Create Certificates", slug: "create_certificates", module: "certificates" },
  { name: "Read Certificates", slug: "read_certificates", module: "certificates" },
  { name: "Update Certificates", slug: "update_certificates", module: "certificates" },
  { name: "Delete Certificates", slug: "delete_certificates", module: "certificates" },

  // Dashboard
  { name: "Read Dashboard", slug: "read_dashboard", module: "dashboard" },

  // EDA Requirements
  { name: "Create EDA Requirements", slug: "create_eda_requirements", module: "eda_requirements" },
  { name: "Read EDA Requirements", slug: "read_eda_requirements", module: "eda_requirements" },
  { name: "Update EDA Requirements", slug: "update_eda_requirements", module: "eda_requirements" },
  { name: "Delete EDA Requirements", slug: "delete_eda_requirements", module: "eda_requirements" },
];

async function main() {
  console.log("🌱 Starting database seeding...");

  // 1. Seed Permissions
  console.log("Seeding permissions...");
  const dbPermissions = [];
  for (const perm of permissions) {
    const dbPerm = await prisma.permission.upsert({
      where: { slug: perm.slug },
      update: { name: perm.name, module: perm.module },
      create: perm,
    });
    dbPermissions.push(dbPerm);
  }
  console.log(`Successfully seeded ${dbPermissions.length} permissions.`);

  // 2. Seed Admin Role
  console.log("Seeding Admin role...");
  const adminRole = await prisma.role.upsert({
    where: { name: "Admin" },
    update: {},
    create: {
      name: "Admin",
      description: "Super Administrator with full system permissions",
    },
  });
  console.log(`Admin role verified: ${adminRole.id}`);

  // 3. Link all permissions to Admin Role
  console.log("Linking permissions to Admin role...");
  for (const perm of dbPermissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: adminRole.id,
          permissionId: perm.id,
        },
      },
      update: {},
      create: {
        roleId: adminRole.id,
        permissionId: perm.id,
      },
    });
  }
  console.log("All permissions successfully linked to Admin role.");

  // 4. Create default Admin User
  console.log("Seeding default Admin user...");
  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminEmail = process.env.ADMIN_EMAIL || "admin@mostanad.com";
  
  const rawPassword = process.env.ADMIN_PASSWORD;
  if (!rawPassword) {
    console.warn("⚠️ WARNING: ADMIN_PASSWORD environment variable is not set. Using default insecure password 'admin123'. PLEASE SET IT IN .env");
  }
  const hashedPassword = await bcrypt.hash(rawPassword || "admin123", 10);

  const adminUser = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {
      email: adminEmail,
      password: hashedPassword,
      roleId: adminRole.id,
    },
    create: {
      name: "System Admin",
      username: adminUsername,
      email: adminEmail,
      password: hashedPassword,
      roleId: adminRole.id,
    },
  });
  console.log(`Admin user seeded: ${adminUser.username} (${adminUser.email})`);

  console.log("🌱 Database seeding completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Error seeding database:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
