-- Database schema for math_site user accounts

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    stripe_customer_id VARCHAR(255),
    free_sessions INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster lookups
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_stripe ON users(stripe_customer_id);

-- Sessions table
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    student_id INTEGER REFERENCES users(id),
    slot_date DATE NOT NULL,
    slot_hour INTEGER NOT NULL CHECK (slot_hour >= 8 AND slot_hour <= 18),
    status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'pending', 'confirmed')),
    subject VARCHAR(100),
    textbook VARCHAR(255),
    chapter VARCHAR(255),
    struggling TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(slot_date, slot_hour)
);

CREATE INDEX idx_sessions_date ON sessions(slot_date);
CREATE INDEX idx_sessions_status ON sessions(status);