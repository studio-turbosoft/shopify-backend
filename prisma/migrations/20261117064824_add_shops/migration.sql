-- CreateTable
CREATE TABLE "shops" (
    "id" SERIAL NOT NULL,
    "domain" VARCHAR(255) NOT NULL,
    "accessToken" VARCHAR(255) NOT NULL,
    "scope" VARCHAR(1024),
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_domain_key" ON "shops"("domain");
