-- Run these in MySQL to add the new features
-- mysql -u root -p onlinecasino < setup-new-features.sql

-- Progressive jackpot tracking
CREATE TABLE IF NOT EXISTS Settings (
    `Key` VARCHAR(100) PRIMARY KEY,
    Value VARCHAR(255) NOT NULL
);
INSERT INTO Settings (`Key`, Value) VALUES ('jackpot', '1000')
    ON DUPLICATE KEY UPDATE Value = Value;

-- Daily login bonuses
CREATE TABLE IF NOT EXISTS DailyClaims (
    ClaimID INT AUTO_INCREMENT PRIMARY KEY,
    UserID INT NOT NULL,
    ClaimDate DATE NOT NULL,
    Amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    Streak INT NOT NULL DEFAULT 1,
    FOREIGN KEY (UserID) REFERENCES Users(UserID)
);

-- Voucher / promo codes
CREATE TABLE IF NOT EXISTS Vouchers (
    VoucherID INT AUTO_INCREMENT PRIMARY KEY,
    Code VARCHAR(50) NOT NULL UNIQUE,
    Amount DECIMAL(10,2) NOT NULL,
    IsUsed TINYINT(1) NOT NULL DEFAULT 0,
    UsedBy INT NULL,
    UsedAt DATETIME NULL,
    ExpiresAt DATETIME NULL,
    CreatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed some test vouchers
INSERT INTO Vouchers (Code, Amount) VALUES ('WELCOME50', 50)
    ON DUPLICATE KEY UPDATE Code = Code;
INSERT INTO Vouchers (Code, Amount) VALUES ('FREESPINS', 25)
    ON DUPLICATE KEY UPDATE Code = Code;
INSERT INTO Vouchers (Code, Amount) VALUES ('HIGHROLLER', 200)
    ON DUPLICATE KEY UPDATE Code = Code;
