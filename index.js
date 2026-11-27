import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import multer from 'multer';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 8000;

// ---------------------------------------------------------------------------
// Auth configuration (JWT)
// ---------------------------------------------------------------------------
// JWT_SECRET is used to sign/verify access tokens issued by /auth/token.
// Never commit real secrets - keep them in the .env file.
const JWT_SECRET =
    process.env.JWT_SECRET ||
    process.env.BETTER_AUTH_SECRET ||
    'wedplan-jwt-secret-change-me';

if (!process.env.JWT_SECRET && !process.env.BETTER_AUTH_SECRET) {
    console.warn(
        '[WedPlan] WARNING: JWT_SECRET is not set in .env. Using an insecure fallback. Please add JWT_SECRET to your .env file.'
    );
}

// The Next.js (Better Auth) application URL. Used to verify Better Auth
// session tokens server-side. Example: http://localhost:3000
const AUTH_URL = (process.env.BETTER_AUTH_URL || 'http://localhost:3000').replace(
    /\/+$/,
    ''
);

const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// Stripe webhook MUST receive the raw request body for signature verification,
// so it is registered before express.json().
// ---------------------------------------------------------------------------
app.post(
    '/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!webhookSecret) {
            console.warn(
                '[Stripe] STRIPE_WEBHOOK_SECRET is not configured - webhook events are ignored.'
            );
            return res
                .status(400)
                .send({ received: false, message: 'Webhook secret not configured' });
        }

        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                req.headers['stripe-signature'],
                webhookSecret
            );
        } catch (error) {
            console.error('[Stripe] Webhook signature verification failed:', error.message);
            return res
                .status(400)
                .send({ received: false, message: `Webhook Error: ${error.message}` });
        }

        // Premium access is ONLY activated through verified webhook events.
        try {
            if (
                event.type === 'checkout.session.completed' ||
                event.type === 'checkout.session.async_payment_succeeded'
            ) {
                const session = event.data.object;

                if (session.payment_status === 'paid') {
                    const userId = session.metadata?.userId;

                    // Save the transaction (idempotent - one record per session)
                    const existingPayment = await payments.findOne({
                        sessionId: session.id,
                    });

                    if (!existingPayment) {
                        await payments.insertOne({
                            sessionId: session.id,
                            status: session.status,
                            payment_status: session.payment_status,
                            customer_email: session.customer_email || '',
                            userId: userId || null,
                            payment_date: new Date(),
                            payment_intent: session.payment_intent || null,
                            amount: session.amount_total ?? null,
                            currency: session.currency || 'usd',
                            plan: 'Premium',
                            source: 'stripe-webhook',
                        });
                    }

                    // Activate premium for the paying vendor
                    if (userId && ObjectId.isValid(String(userId))) {
                        await users.updateOne(
                            { _id: new ObjectId(String(userId)) },
                            {
                                $set: {
                                    premium: true,
                                    premiumActivatedAt: new Date(),
                                },
                            }
                        );
                        console.log(`[Stripe] Premium activated for user ${userId}`);
                    }
                }
            }
        } catch (error) {
            console.error('[Stripe] Webhook handling error:', error);
            return res.status(500).send({ received: false, message: 'Webhook handler failed' });
        }

        res.json({ received: true });
    }
);

// ---------------------------------------------------------------------------
// Basic middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(cors());

const myLogger = (req, res, next) => {
    console.log('request on the server', req.method, req.url);
    next();
};
app.use(myLogger);

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const client = new MongoClient(
    `mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-sed4pgj-shard-00-00.la1zoji.mongodb.net:27017,ac-sed4pgj-shard-00-01.la1zoji.mongodb.net:27017,ac-sed4pgj-shard-00-02.la1zoji.mongodb.net:27017/?ssl=true&replicaSet=atlas-sjdwaf-shard-0&authSource=admin`
);

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log('You successfully connected to MongoDB!');
        return client;
    } catch (err) {
        console.dir(err);
        throw err;
    }
}

const connectedClient = await connectToMongoDB();
const database = connectedClient.db('wedplan');
const users = database.collection('user');
const services = database.collection('services');
const bookingsrequest = database.collection('bookingsrequest');
const payments = database.collection('payments');

app.get('/', (req, res) => {
    res.send('wedplan webpage');
});

// ---------------------------------------------------------------------------
// JWT authentication middleware
// ---------------------------------------------------------------------------
// Accepts either:
//   1. A JWT issued by POST /auth/token  (verified locally with jsonwebtoken)
//   2. A Better Auth session token       (verified against the Next.js app)
// In both cases the user is re-loaded from the database so the role and the
// blocked status are always trusted from the server, never from the client.
const verifyJwtToken = (token) => {
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (!payload || (!payload.userId && !payload.email)) return null;
        return {
            userId: payload.userId ? String(payload.userId) : '',
            email: payload.email || '',
            name: payload.name || '',
            role: payload.role || 'customer',
        };
    } catch {
        return null;
    }
};

const verifyBetterAuthToken = async (token) => {
    try {
        const response = await fetch(`${AUTH_URL}/api/auth/get-session`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data || !data.user) return null;
        return {
            userId: data.user.id ? String(data.user.id) : '',
            email: data.user.email || '',
            name: data.user.name || '',
            role: data.user.role || 'customer',
        };
    } catch (error) {
        console.error('Better Auth token verification failed:', error.message);
        return null;
    }
};

const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res
                .status(401)
                .send({ success: false, message: 'Unauthorized: authentication token is missing' });
        }

        const token = authHeader.slice(7).trim();
        if (!token) {
            return res
                .status(401)
                .send({ success: false, message: 'Unauthorized: authentication token is missing' });
        }

        // 1) Try a locally verifiable JWT first, 2) then a Better Auth session token.
        let identity = verifyJwtToken(token);
        if (!identity) {
            identity = await verifyBetterAuthToken(token);
        }
        if (!identity) {
            return res
                .status(401)
                .send({ success: false, message: 'Unauthorized: invalid or expired token' });
        }

        // Load the user from the database (source of truth for role + block state)
        let dbUser = null;
        if (identity.userId && ObjectId.isValid(identity.userId)) {
            dbUser = await users.findOne({ _id: new ObjectId(identity.userId) });
        }
        if (!dbUser && identity.email) {
            dbUser = await users.findOne({ email: identity.email });
        }

        if (dbUser && dbUser.isBlocked === true) {
            return res
                .status(403)
                .send({ success: false, message: 'Forbidden: your account has been blocked' });
        }

        req.user = {
            userId: dbUser && dbUser._id ? String(dbUser._id) : identity.userId,
            email: (dbUser && dbUser.email) || identity.email,
            name: (dbUser && dbUser.name) || identity.name,
            role: (dbUser && dbUser.role) || identity.role || 'customer',
            premium: Boolean(dbUser && dbUser.premium),
        };

        next();
    } catch (error) {
        console.error('verifyToken error:', error);
        res.status(500).send({ success: false, message: 'Authentication failed' });
    }
};

// Role based middleware -> 403 when the authenticated user's role is not allowed
const requireRole =
    (...allowedRoles) =>
        (req, res, next) => {
            if (!req.user) {
                return res.status(401).send({ success: false, message: 'Unauthorized' });
            }
            if (!allowedRoles.includes(req.user.role)) {
                return res
                    .status(403)
                    .send({
                        success: false,
                        message: 'Forbidden: you do not have permission to perform this action',
                    });
            }
            next();
        };

// Ownership helper -> returns true when the resource belongs to the user (or user is admin)
const ownsResource = (req, ownerEmail) => {
    if (!ownerEmail) return false;
    if (req.user.role === 'admin') return true;
    return String(ownerEmail).toLowerCase() === String(req.user.email).toLowerCase();
};

// ---------------------------------------------------------------------------
// Auth: exchange a Better Auth session token for a JWT
// ---------------------------------------------------------------------------
app.post('/auth/token', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).send({ success: false, message: 'Unauthorized' });
        }

        const token = authHeader.slice(7).trim();
        if (!token) {
            return res.status(401).send({ success: false, message: 'Unauthorized' });
        }

        let identity = verifyJwtToken(token);
        if (!identity) {
            identity = await verifyBetterAuthToken(token);
        }
        if (!identity) {
            return res
                .status(401)
                .send({ success: false, message: 'Unauthorized: invalid session token' });
        }

        // Refresh role / blocked status from the database
        if (identity.userId && ObjectId.isValid(identity.userId)) {
            const dbUser = await users.findOne({ _id: new ObjectId(identity.userId) });
            if (dbUser) {
                if (dbUser.isBlocked === true) {
                    return res
                        .status(403)
                        .send({ success: false, message: 'Forbidden: your account has been blocked' });
                }
                identity.role = dbUser.role || identity.role;
                identity.email = dbUser.email || identity.email;
                identity.name = dbUser.name || identity.name;
            }
        }

        const accessToken = jwt.sign(
            {
                userId: identity.userId,
                email: identity.email,
                name: identity.name,
                role: identity.role,
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.send({
            success: true,
            token: accessToken,
            tokenType: 'Bearer',
            expiresIn: 60 * 60 * 24 * 7,
        });
    } catch (error) {
        console.error('Issue Token Error:', error);
        res.status(500).send({ success: false, message: 'Failed to issue access token' });
    }
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
app.get('/users', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const result = await users.find({}).toArray();
        res.send(result);
    } catch (error) {
        console.error('Fetch Users Error:', error);
        res.status(500).send({ success: false, message: 'Failed to fetch users' });
    }
});

app.get('/users/:id/premium', verifyToken, async (req, res) => {
    try {
        const _id = req.params.id;

        if (!ObjectId.isValid(_id)) {
            return res.status(400).send({ success: false, message: 'Invalid user id' });
        }

        // Only the owner (or an admin) may read premium status
        if (req.user.role !== 'admin' && req.user.userId !== _id) {
            return res
                .status(403)
                .send({ success: false, message: 'Forbidden: you can only view your own subscription' });
        }

        const result = await users.findOne(
            { _id: new ObjectId(_id) },
            { projection: { premium: 1 } }
        );

        if (!result) {
            return res.status(404).send({ success: false, message: 'User not found' });
        }

        res.send({ premium: result.premium === true });
    } catch (error) {
        console.error('Fetch Premium Error:', error);
        res.status(500).send({ success: false, message: 'Failed to fetch subscription status' });
    }
});

// Block / Unblock user (admin only)
app.patch('/users/:id/block', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const _id = req.params.id;
        const { isBlocked } = req.body;

        if (typeof isBlocked !== 'boolean') {
            return res
                .status(400)
                .send({ success: false, message: 'isBlocked must be a boolean value' });
        }

        if (!ObjectId.isValid(_id)) {
            return res.status(400).send({ success: false, message: 'Invalid user id' });
        }

        const target = await users.findOne({ _id: new ObjectId(_id) });
        if (!target) {
            return res.status(404).send({ success: false, message: 'User not found' });
        }

        if (target.role === 'admin') {
            return res
                .status(403)
                .send({ success: false, message: 'Forbidden: admin accounts cannot be blocked' });
        }

        const update = {
            $set: {
                isBlocked,
                blockedAt: isBlocked ? new Date() : null,
            },
        };

        const result = await users.updateOne({ _id: new ObjectId(_id) }, update);

        res.send({
            success: true,
            modifiedCount: result.modifiedCount,
            message: `User ${isBlocked ? 'blocked' : 'unblocked'} successfully`,
        });
    } catch (error) {
        console.error('Block User Error:', error);
        res.status(500).send({ success: false, message: 'Failed to update user status' });
    }
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
app.get('/add-service', async (req, res) => {
    try {
        const { search, category, location, vendorEmail, status, isAvailable } = req.query;
        const query = {};

        if (search) {
            query.serviceName = { $regex: search, $options: 'i' };
        }
        if (category) {
            query.category = { $regex: category, $options: 'i' };
        }
        if (location) {
            query.location = { $regex: location, $options: 'i' };
        }
        if (vendorEmail) {
            query.vendorEmail = vendorEmail;
        }
        if (status) {
            query.status = status;
        }
        if (isAvailable === 'true' || isAvailable === 'false') {
            query.isAvailable = isAvailable === 'true';
        }

        const result = await services.find(query).toArray();
        res.send(result);
    } catch (error) {
        console.error('Fetch Services Error:', error);
        res.status(500).send({ success: false, message: 'Failed to fetch services' });
    }
});

// Active service count (used for the free plan limit check)
app.get('/services/count', verifyToken, async (req, res) => {
    try {
        // A vendor can only count their own services; admins may pass vendorEmail
        const vendorEmail =
            req.user.role === 'admin'
                ? req.query.vendorEmail || null
                : req.user.email;

        if (!vendorEmail) {
            return res.status(400).send({ success: false, message: 'vendorEmail is required' });
        }

        const count = await services.countDocuments({
            vendorEmail,
            isAvailable: true,
            status: { $in: ['Approved', 'Pending'] },
        });

        res.send({ count });
    } catch (error) {
        console.error('Service Count Error:', error);
        res.status(500).send({ success: false, message: 'Failed to count services' });
    }
});

app.post(
    '/add-service',
    verifyToken,
    requireRole('vendor'),
    upload.single('serviceImage'),
    async (req, res) => {
        try {
            const { serviceName, category, description, price, location } = req.body;

            // ---- Server-side request validation ----
            if (!serviceName || !String(serviceName).trim()) {
                return res.status(400).send({ success: false, message: 'Service name is required' });
            }
            if (!category || !String(category).trim()) {
                return res.status(400).send({ success: false, message: 'Service category is required' });
            }
            if (!description || !String(description).trim()) {
                return res.status(400).send({ success: false, message: 'Service description is required' });
            }
            if (price === undefined || price === '' || isNaN(Number(price)) || Number(price) <= 0) {
                return res
                    .status(400)
                    .send({ success: false, message: 'Price must be a positive number' });
            }
            if (!location || !String(location).trim()) {
                return res.status(400).send({ success: false, message: 'Service location is required' });
            }
            if (!req.file) {
                return res.status(400).send({ success: false, message: 'Service image is required' });
            }

            // Vendor identity always comes from the verified token, never from the client
            const vendorEmail = req.user.email;
            const vendorName = req.user.name || req.body.vendorName || 'Vendor';

            // ---- Free plan limitation: max 3 active services (server enforced) ----
            if (!req.user.premium) {
                const activeCount = await services.countDocuments({
                    vendorEmail,
                    isAvailable: true,
                    status: { $in: ['Approved', 'Pending'] },
                });

                if (activeCount >= 3) {
                    return res.status(403).send({
                        success: false,
                        message:
                            'Free plan allows a maximum of 3 active services. Upgrade to Premium for unlimited services.',
                    });
                }
            }

            // ---- Upload service image to ImgBB ----
            const formData = new FormData();
            const imageBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
            formData.append('image', imageBlob, req.file.originalname);

            const imgbbResponse = await fetch(
                `https://api.imgbb.com/1/upload?key=${process.env.NEXT_PUBLIC_IMGBB_API_KEY}`,
                {
                    method: 'POST',
                    body: formData,
                }
            );
            const imageResult = await imgbbResponse.json();

            if (!imageResult.success) {
                throw new Error('ImgBB image upload failed');
            }

            const serviceData = {
                serviceName: String(serviceName).trim(),
                category: String(category).trim(),
                description: String(description).trim(),
                price: Number(price),
                location: String(location).trim(),
                serviceImage: imageResult.data.url,
                vendorName,
                vendorEmail,
                isAvailable: true,
                status: 'Pending', // DEFAULT TO PENDING for admin approval
                createdAt: new Date(),
            };

            const result = await services.insertOne(serviceData);
            res.status(201).send({
                success: true,
                message: 'Service added successfully',
                insertedId: result.insertedId,
            });
        } catch (error) {
            console.error('Add Service Error:', error);
            res.status(500).send({ success: false, message: 'Failed to add service' });
        }
    }
);

// Update a service (owner vendor or admin)
app.patch('/add-service/:id', verifyToken, async (req, res) => {
    try {
        const _id = req.params.id;

        if (!ObjectId.isValid(_id)) {
            return res.status(400).send({ success: false, message: 'Invalid service id' });
        }

        const service = await services.findOne({ _id: new ObjectId(_id) });
        if (!service) {
            return res.status(404).send({ success: false, message: 'Service not found' });
        }

        // Ownership check: only the owning vendor (or an admin) may modify
        if (!ownsResource(req, service.vendorEmail)) {
            return res
                .status(403)
                .send({ success: false, message: 'Forbidden: you can only modify your own services' });
        }

        const body = req.body || {};

        // Availability toggle (also exposed at /services/:id/availability)
        if (typeof body.isAvailable === 'boolean' && Object.keys(body).length === 1) {
            const result = await services.updateOne(
                { _id: new ObjectId(_id) },
                { $set: { isAvailable: body.isAvailable } }
            );
            return res.send({
                success: true,
                message: 'Service availability updated',
                modifiedCount: result.modifiedCount,
            });
        }

        // Full service details update
        const updateFields = {};
        if (body.serviceName !== undefined) {
            if (!String(body.serviceName).trim()) {
                return res.status(400).send({ success: false, message: 'Service name is required' });
            }
            updateFields.serviceName = String(body.serviceName).trim();
        }
        if (body.category !== undefined) {
            if (!String(body.category).trim()) {
                return res.status(400).send({ success: false, message: 'Service category is required' });
            }
            updateFields.category = String(body.category).trim();
        }
        if (body.description !== undefined) {
            if (!String(body.description).trim()) {
                return res.status(400).send({ success: false, message: 'Service description is required' });
            }
            updateFields.description = String(body.description).trim();
        }
        if (body.location !== undefined) {
            if (!String(body.location).trim()) {
                return res.status(400).send({ success: false, message: 'Service location is required' });
            }
            updateFields.location = String(body.location).trim();
        }
        if (body.price !== undefined) {
            if (isNaN(Number(body.price)) || Number(body.price) <= 0) {
                return res
                    .status(400)
                    .send({ success: false, message: 'Price must be a positive number' });
            }
            updateFields.price = Number(body.price);
        }
        if (body.isAvailable !== undefined) {
            updateFields.isAvailable = body.isAvailable === true;
        }

        if (Object.keys(updateFields).length === 0) {
            return res.status(400).send({ success: false, message: 'No valid fields to update' });
        }

        const result = await services.updateOne(
            { _id: new ObjectId(_id) },
            { $set: updateFields }
        );

        res.send({
            success: true,
            message: 'Service updated successfully',
            modifiedCount: result.modifiedCount,
        });
    } catch (error) {
        console.error('Update Service Error:', error);
        res.status(500).send({ success: false, message: 'Failed to update service' });
    }
});

// Availability toggle alias used by the admin Manage Services page
app.patch('/services/:id/availability', verifyToken, async (req, res) => {
    try {
        const _id = req.params.id;

        if (!ObjectId.isValid(_id)) {
            return res.status(400).send({ success: false, message: 'Invalid service id' });
        }

        const service = await services.findOne({ _id: new ObjectId(_id) });
        if (!service) {
            return res.status(404).send({ success: false, message: 'Service not found' });
        }

        if (!ownsResource(req, service.vendorEmail)) {
            return res
                .status(403)
                .send({ success: false, message: 'Forbidden: you can only modify your own services' });
        }

        const { isAvailable } = req.body;
        if (typeof isAvailable !== 'boolean') {
            return res
                .status(400)
                .send({ success: false, message: 'isAvailable must be a boolean value' });
        }

        const result = await services.updateOne(
            { _id: new ObjectId(_id) },
            { $set: { isAvailable } }
        );

        res.send({
            success: true,
            message: 'Service availability updated',
            modifiedCount: result.modifiedCount,
        });
    } catch (error) {
        console.error('Update Availability Error:', error);
        res.status(500).send({ success: false, message: 'Failed to update availability' });
    }
});

// Delete a service (owner vendor or admin)
app.delete('/add-service/:id', verifyToken, async (req, res) => {
    try {
        const _id = req.params.id;

        if (!ObjectId.isValid(_id)) {
            return res.status(400).send({ success: false, message: 'Invalid service id' });
        }

        const service = await services.findOne({ _id: new ObjectId(_id) });
        if (!service) {
            return res.status(404).send({ success: false, message: 'Service not found' });
        }

        if (!ownsResource(req, service.vendorEmail)) {
            return res
                .status(403)
                .send({ success: false, message: 'Forbidden: you can only delete your own services' });
        }

        const result = await services.deleteOne({ _id: new ObjectId(_id) });
        res.send(result);
    } catch (error) {
        console.error('Delete Service Error:', error);
        res.status(500).send({ success: false, message: 'Failed to delete service' });
    }
});

// Approve / Reject a submitted service (admin only)
app.patch(
    '/add-service/:id/approve',
    verifyToken,
    requireRole('admin'),
    async (req, res) => {
        try {
            const _id = req.params.id;
            const { status } = req.body;

            if (!['Approved', 'Rejected', 'Pending'].includes(status)) {
                return res
                    .status(400)
                    .send({ success: false, message: 'Invalid service status value' });
            }

            if (!ObjectId.isValid(_id)) {
                return res.status(400).send({ success: false, message: 'Invalid service id' });
            }

            const query = { _id: new ObjectId(_id) };
            const update = { $set: { status } };
            const result = await services.updateOne(query, update);

            if (result.matchedCount === 0) {
                return res.status(404).send({ success: false, message: 'Service not found' });
            }

            res.send({
                success: true,
                message: `Service ${status.toLowerCase()} successfully`,
            });
        } catch (error) {
            console.error('Approve/Reject Service Error:', error);
            res.status(500).send({ success: false, message: 'Failed to update service status' });
        }
    }
);

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
app.get('/bookingsrequest', verifyToken, async (req, res) => {
    try {
        const query = {};
        if (req.query.status) query.status = req.query.status;
        if (req.query.email) query.email = req.query.email;

        const cursor = bookingsrequest.find(query).sort({ requestDate: -1 });
        const result = await cursor.toArray();
        res.send(result);
    } catch (error) {
        console.error('Fetch Booking Requests Error:', error);
        res.status(500).send({ success: false, message: 'Failed to fetch booking requests' });
    }
});

app.get('/bookingsrequest/count', verifyToken, async (req, res) => {
    try {
        const query = {};
        if (req.query.status) query.status = req.query.status;
        if (req.query.email) query.email = req.query.email;
        if (req.query.bookingId) query.bookingId = req.query.bookingId;

        const result = await bookingsrequest.countDocuments(query);
        res.send({ count: result });
    } catch (error) {
        console.error('Booking Count Error:', error);
        res.status(500).send({ success: false, message: 'Failed to count booking requests' });
    }
});

// Create a booking request (customers only)
app.post('/bookingsrequest', verifyToken, requireRole('customer'), async (req, res) => {
    try {
        const {
            bookingId,
            BookingDate,
            BookingLocation,
            AdditionalMessage,
        } = req.body;

        // ---- Server-side validation ----
        if (!bookingId || !/^[0-9a-fA-F]{24}$/.test(String(bookingId))) {
            return res.status(400).send({ success: false, message: 'Invalid service selected' });
        }
        if (!BookingDate || isNaN(new Date(BookingDate).getTime())) {
            return res.status(400).send({ success: false, message: 'A valid event date is required' });
        }
        if (!BookingLocation || !String(BookingLocation).trim()) {
            return res.status(400).send({ success: false, message: 'Event location is required' });
        }

        const service = await services.findOne({ _id: new ObjectId(String(bookingId)) });
        if (!service) {
            return res.status(404).send({ success: false, message: 'Service not found' });
        }

        // Only approved and active services can be booked
        if (service.status !== 'Approved' || service.isAvailable === false) {
            return res
                .status(400)
                .send({ success: false, message: 'This service is not available for booking' });
        }

        // Customers cannot book their own services
        if (
            service.vendorEmail &&
            String(service.vendorEmail).toLowerCase() === String(req.user.email).toLowerCase()
        ) {
            return res
                .status(403)
                .send({ success: false, message: 'You cannot book your own service' });
        }

        // Prevent duplicate active booking requests (same service + same event date)
        const duplicate = await bookingsrequest.findOne({
            bookingId: String(bookingId),
            email: req.user.email,
            $or: [{ BookingDate }, { eventDate: BookingDate }],
            status: { $in: ['Pending', 'Accepted'] },
        });

        if (duplicate) {
            return res.status(409).send({
                success: false,
                message: 'You already have an active booking request for this service on the selected date',
            });
        }

        const bookingsrequests = {
            bookingId: String(bookingId),
            customerId: req.user.userId,
            customerName: req.user.name || 'Customer',
            email: req.user.email,
            serviceName: service.serviceName,
            serviceImage: service.serviceImage || '',
            vendorName: service.vendorName || 'Vendor',
            vendorEmail: service.vendorEmail || '',
            BookingDate,
            BookingLocation: String(BookingLocation).trim(),
            AdditionalMessage: AdditionalMessage ? String(AdditionalMessage).trim() : '',
            status: 'Pending',
            requestDate: new Date(),
        };

        const result = await bookingsrequest.insertOne(bookingsrequests);
        res.status(201).send({
            success: true,
            message: 'Booking request submitted successfully',
            insertedId: result.insertedId,
        });
    } catch (error) {
        console.error('Create Booking Error:', error);
        res.status(500).send({ success: false, message: 'Failed to create booking request' });
    }
});

// Bookings for a vendor's services
app.get('/vendor-bookings/:vendorEmail', verifyToken, async (req, res) => {
    try {
        const { vendorEmail } = req.params;

        // Vendors can only access their own bookings
        if (req.user.role !== 'admin') {
            if (req.user.role !== 'vendor') {
                return res.status(403).send({
                    success: false,
                    message: 'Forbidden: vendors only',
                });
            }

            if (
                String(vendorEmail).toLowerCase() !==
                String(req.user.email).toLowerCase()
            ) {
                return res.status(403).send({
                    success: false,
                    message: 'You can only view your own booking requests',
                });
            }
        }

        // Find vendor's services
        const vendorServices = await services
            .find(
                { vendorEmail },
                { projection: { _id: 1 } }
            )
            .toArray();

        const serviceIds = vendorServices.map(service =>
            String(service._id)
        );

        // Count booking requests received by this vendor
        const bookingCount = await bookingsrequest.countDocuments({
            bookingId: { $in: serviceIds },
        });

        // Free plan: maximum 3 services
        const currentUser = await users.findOne(
            { email: vendorEmail },
            { projection: { premium: 1 } }
        );

        const isPremium = currentUser?.premium === true;

        if (!isPremium) {
            const serviceCount = await services.countDocuments({
                vendorEmail: vendorEmail,
            });

            if (serviceCount >= 3) {
                return res.status(403).send({
                    success: false,
                    upgradeRequired: true,
                    message: 'Free plan allows only 3 services. Upgrade to Premium.',
                });
            }
        }

        // Fetch vendor bookings
        const requests = await bookingsrequest
            .find({ bookingId: { $in: serviceIds } })
            .sort({ requestDate: -1 })
            .toArray();

        const vendorBookings = requests.map(booking => ({
            ...booking,
            customerName: booking.customerName || 'Customer',
            eventDate: booking.BookingDate,
            eventLocation: booking.BookingLocation,
            status: booking.status || 'Pending',
        }));

        res.send(vendorBookings);

    } catch (error) {
        console.error('Fetch Vendor Bookings Error:', error);

        res.status(500).send({
            success: false,
            message: 'Failed to fetch bookings',
        });
    }
});

// Vendor accepts / rejects a booking request (only pending, only own services)
app.patch('/vendor-bookings/:id/status', verifyToken, requireRole('vendor'), async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['Accepted', 'Rejected'].includes(status)) {
            return res
                .status(400)
                .send({ success: false, message: 'Status must be Accepted or Rejected' });
        }

        if (!ObjectId.isValid(id)) {
            return res.status(400).send({ success: false, message: 'Invalid booking id' });
        }

        const booking = await bookingsrequest.findOne({ _id: new ObjectId(id) });
        if (!booking) {
            return res.status(404).send({ success: false, message: 'Booking request not found' });
        }

        // Ownership: the booking must belong to a service owned by this vendor
        let service = null;
        if (booking.bookingId && ObjectId.isValid(booking.bookingId)) {
            service = await services.findOne({ _id: new ObjectId(booking.bookingId) });
        }

        if (!service || !ownsResource(req, service.vendorEmail)) {
            return res
                .status(403)
                .send({ success: false, message: 'Forbidden: you cannot modify booking requests of other vendors' });
        }

        // Only pending requests can be processed, and only once
        if (booking.status !== 'Pending') {
            return res.status(409).send({
                success: false,
                message: `This request has already been ${String(booking.status || 'processed').toLowerCase()} and cannot be processed again`,
            });
        }

        await bookingsrequest.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, processedAt: new Date(), processedBy: req.user.email } }
        );

        res.send({ success: true, message: `Booking request ${status.toLowerCase()} successfully` });
    } catch (error) {
        console.error('Update Booking Status Error:', error);
        res.status(500).send({ success: false, message: 'Failed to update booking status' });
    }
});

// A customer's own bookings
app.get('/my-bookings/:customerEmail', verifyToken, async (req, res) => {
    try {
        const { customerEmail } = req.params;

        // Customers may only read their own bookings; admins may read any
        if (req.user.role !== 'admin') {
            if (
                String(customerEmail).toLowerCase() !== String(req.user.email).toLowerCase()
            ) {
                return res
                    .status(403)
                    .send({ success: false, message: 'Forbidden: you can only view your own bookings' });
            }
        }

        const bookings = await bookingsrequest
            .find({ email: customerEmail })
            .sort({ requestDate: -1 })
            .toArray();

        const enriched = await Promise.all(
            bookings.map(async (booking) => {
                let serviceName = booking.serviceName || 'Unknown Service';
                let serviceImage = booking.serviceImage || '';
                let vendorName = booking.vendorName || 'Unknown Vendor';
                let vendorEmail = booking.vendorEmail || '';

                try {
                    if (booking.bookingId && ObjectId.isValid(booking.bookingId)) {
                        const service = await services.findOne({
                            _id: new ObjectId(booking.bookingId),
                        });
                        if (service) {
                            serviceName = service.serviceName || serviceName;
                            serviceImage = service.serviceImage || serviceImage;
                            vendorName = service.vendorName || vendorName;
                            vendorEmail = service.vendorEmail || vendorEmail;
                        }
                    }
                } catch (err) {
                    /* Invalid ObjectId - keep defaults */
                }

                return {
                    ...booking,
                    customerName: booking.customerName || 'Customer',
                    customerEmail: booking.email,
                    serviceName,
                    serviceImage,
                    vendorName,
                    vendorEmail,
                    status: booking.status || 'Pending',
                    requestDate: booking.requestDate || new Date(),
                    eventDate: booking.BookingDate || booking.eventDate || '',
                    eventLocation: booking.BookingLocation || booking.eventLocation || '',
                };
            })
        );

        res.send(enriched);
    } catch (error) {
        console.error('Fetch My Bookings Error:', error);
        res.status(500).send({ success: false, message: 'Failed to load bookings' });
    }
});

// A customer cancels their own pending booking
app.patch('/booking/:id/cancel', verifyToken, requireRole('customer'), async (req, res) => {
    try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
            return res.status(400).send({ success: false, message: 'Invalid booking id' });
        }

        const booking = await bookingsrequest.findOne({ _id: new ObjectId(id) });
        if (!booking) {
            return res.status(404).send({ success: false, message: 'Booking not found' });
        }

        // Ownership: customers cannot cancel another customer's booking
        if (String(booking.email).toLowerCase() !== String(req.user.email).toLowerCase()) {
            return res
                .status(403)
                .send({ success: false, message: 'Not authorized to cancel this booking' });
        }

        if (booking.status && booking.status !== 'Pending') {
            return res
                .status(400)
                .send({ success: false, message: `Cannot cancel a ${booking.status} booking` });
        }

        await bookingsrequest.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: 'Cancelled', cancelledAt: new Date() } }
        );

        res.send({ success: true, message: 'Booking cancelled successfully' });
    } catch (error) {
        console.error('Cancel Booking Error:', error);
        res.status(500).send({ success: false, message: 'Failed to cancel booking' });
    }
});

// ---------------------------------------------------------------------------
// Profile image upload (ImgBB)
// ---------------------------------------------------------------------------
app.post(
    '/upload-profile-image',
    verifyToken,
    upload.single('profileImage'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).send({ message: 'No image selected' });
            }

            if (!process.env.NEXT_PUBLIC_IMGBB_API_KEY) {
                return res.status(500).send({ message: 'ImgBB API key is missing' });
            }

            const formData = new FormData();
            formData.append(
                'image',
                new Blob([req.file.buffer], { type: req.file.mimetype }),
                req.file.originalname
            );

            const response = await fetch(
                `https://api.imgbb.com/1/upload?key=${process.env.NEXT_PUBLIC_IMGBB_API_KEY}`,
                {
                    method: 'POST',
                    body: formData,
                }
            );

            const result = await response.json();

            if (!response.ok || !result.success) {
                console.log('ImgBB Error:', result.error);
                return res
                    .status(500)
                    .send({ message: result.error?.message || 'ImgBB upload failed' });
            }

            res.send({ success: true, imageUrl: result.data.url });
        } catch (error) {
            console.error('Profile image upload error:', error);
            res.status(500).send({ message: 'Server image upload error' });
        }
    }
);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
// Verifies the checkout session with Stripe and saves the transaction.
// NOTE: Premium access is NOT activated here - it is only activated through
// the verified Stripe webhook event (/stripe/webhook).
app.post('/payments/checkout-verify', verifyToken, async (req, res) => {
    try {
        const { session_id } = req.body;

        if (!session_id || typeof session_id !== 'string') {
            return res.status(400).send({ success: false, message: 'session_id is required' });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.status === 'complete' && session.payment_status === 'paid') {
            // The session must belong to the authenticated user (or admin)
            const sessionUserId = session.metadata?.userId
                ? String(session.metadata.userId)
                : '';
            const sessionEmail = session.customer_email || '';
            const isOwner =
                (sessionUserId && sessionUserId === req.user.userId) ||
                (sessionEmail && sessionEmail.toLowerCase() === req.user.email.toLowerCase());

            if (!isOwner && req.user.role !== 'admin') {
                return res
                    .status(403)
                    .send({ success: false, message: 'Forbidden: this payment does not belong to you' });
            }

            // Idempotent - never record the same payment twice
            const existingPayment = await payments.findOne({ sessionId: session_id });
            let result = existingPayment;

            if (!existingPayment) {
                const payment = {
                    sessionId: session_id,
                    status: session.status,
                    payment_status: session.payment_status,
                    customer_email: session.customer_email || '',
                    userId: sessionUserId || null,
                    payment_date: new Date(),
                    payment_intent: session.payment_intent || null,
                    amount: session.amount_total ?? null,
                    currency: session.currency || 'usd',
                    plan: 'Premium',
                    source: 'checkout-verify',
                };
                result = await payments.insertOne(payment);
            }

            return res.send({
                success: true,
                verified: true,
                premiumActivated: false,
                result,
                message:
                    'Payment verified. Premium access will be activated after Stripe confirms the payment through the webhook.',
            });
        }

        return res
            .status(400)
            .send({ success: false, message: 'Payment verification failed' });
    } catch (error) {
        console.error('Checkout Verify Error:', error);
        res.status(500).send({
            success: false,
            message: 'Payment verification failed',
            error: error.message,
        });
    }
});

// Admin: read-only list of platform transactions (payment records are never modified)
app.get('/transactions', verifyToken, requireRole('admin'), async (req, res) => {
    try {
        const paymentsList = await payments.find({}).sort({ payment_date: -1 }).toArray();

        const enriched = await Promise.all(
            paymentsList.map(async (payment) => {
                let vendorName = 'Unknown Vendor';
                let vendorEmail = payment.customer_email || '';

                if (payment.userId && ObjectId.isValid(String(payment.userId))) {
                    const user = await users.findOne(
                        { _id: new ObjectId(String(payment.userId)) },
                        { projection: { name: 1, email: 1 } }
                    );
                    if (user) {
                        vendorName = user.name || vendorName;
                        vendorEmail = user.email || vendorEmail;
                    }
                }

                return {
                    _id: payment._id,
                    vendorName,
                    vendorEmail,
                    plan: payment.plan || 'Premium',
                    amount: payment.amount ?? null,
                    currency: payment.currency || 'usd',
                    status: payment.payment_status || payment.status || 'pending',
                    date: payment.payment_date || null,
                    sessionId: payment.sessionId || '',
                };
            })
        );

        res.send(enriched);
    } catch (error) {
        console.error('Fetch Transactions Error:', error);
        res.status(500).send({ success: false, message: 'Failed to fetch transactions' });
    }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
// Unknown routes -> 404
app.use((req, res) => {
    res.status(404).send({ success: false, message: 'Route not found' });
});

// Central error handler -> never leak stack traces to the client
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err);
    res
        .status(err.status || 500)
        .send({ success: false, message: err.message || 'Internal server error' });
});

app.listen(port, () => {
    console.log(`server is running on port ${port}`);
    console.log(`Auth verification URL: ${AUTH_URL}`);
});

export default app;
