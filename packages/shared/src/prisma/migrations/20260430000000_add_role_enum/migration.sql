-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'LEAD', 'ENGINEER');

-- AlterTable users.role: TEXT -> Role enum
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING "role"::"Role";
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'ENGINEER'::"Role";

-- AlterTable team_memberships.role: TEXT -> Role enum
ALTER TABLE "team_memberships" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "team_memberships" ALTER COLUMN "role" TYPE "Role" USING "role"::"Role";
ALTER TABLE "team_memberships" ALTER COLUMN "role" SET DEFAULT 'ENGINEER'::"Role";
