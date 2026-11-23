import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'
import multer from 'multer';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(cors());
const upload = multer({ storage: multer.memoryStorage() });

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-sed4pgj-shard-00-00.la1zoji.mongodb.net:27017,ac-sed4pgj-shard-00-01.la1zoji.mongodb.net:27017,ac-sed4pgj-shard-00-02.la1zoji.mongodb.net:27017/?ssl=true&replicaSet=atlas-sjdwaf-shard-0&authSource=admin`);

const myLogger = (req, res , next) => {
    console.log('headers on the server', req.url, req.query);
    next();
}

export async function connectToMongoDB() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");
        return client;
    } catch (err) {
        console.dir(err);
    }
}
const connectedClient = await connectToMongoDB()
const database = connectedClient.db('wedplan');
const users = database.collection("user");
const services = database.collection("services");
const bookingsrequest = database.collection("bookingsrequest");
const payments = database.collection("payments");

app.get('/', (req, res) => {
    res.send('wedplan webpage');
});
const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.send({ status: 401, message: "UNAuthorization" });
        return;
    }
    const token = authHeader.split(' ')[1];
    if(!token){
        res.send({ status: 401, message: "UNAuthorization" });
        return;
    }
   
}

app.get('/users', async (req, res) => {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})
app.get('/users/:id/premium', async (req, res) => {
    const _id = req.params.id;
    const query = { _id: new ObjectId(_id) };
    const result = await users.findOne(query, { projection: { premium: 1 } });
    res.send(result);
});

app.get('/add-service', async (req, res) => {
    const { search, category, location } = req.query;
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
    const result = await services.find(query).toArray();
    res.send(result);
});

app.post('/add-service', upload.single('serviceImage'), async (req, res) => {
    try {
        const { serviceName, category, description, price, location, vendorName, vendorEmail } = req.body;

        if (!req.file) {
            return res.status(400).send({ success: false, message: "Service image is required" });
        }

        const formData = new FormData();
        const imageBlob = new Blob([req.file.buffer], { type: req.file.mimetype });
        formData.append('image', imageBlob, req.file.originalname);

        const imgbbResponse = await fetch(`https://api.imgbb.com/1/upload?key=${process.env.NEXT_PUBLIC_IMGBB_API_KEY}`, {
            method: 'POST', body: formData
        });
        const imageResult = await imgbbResponse.json();

        if (!imageResult.success) {
            throw new Error("ImgBB image upload failed");
        }

        const imageUrl = imageResult.data.url;

        const serviceData = {
            serviceName,
            category,
            description,
            price: Number(price),
            location,
            serviceImage: imageUrl,
            vendorName,
            vendorEmail,
            isAvailable: true,
            status: "Pending",   // <-- DEFAULT TO PENDING for admin approval
            createdAt: new Date()
        };

        const result = await services.insertOne(serviceData);
        res.status(201).send({ success: true, message: "Service added successfully", insertedId: result.insertedId });
    } catch (error) {
        console.error("Add Service Error:", error);
        res.status(500).send({ success: false, message: "Failed to add service", error: error.message });
    }
});

app.delete('/add-service/:id', async (req, res) => {
    const _id = req.params.id;
    const query = { _id: new ObjectId(_id) };
    const result = await services.deleteOne(query);
    res.send(result)
})

app.patch('/add-service/:id', async (req, res) => {
    try {
        const _id = req.params.id;
        const { isAvailable } = req.body;
        const query = { _id: new ObjectId(_id) };
        const update = { $set: { isAvailable: isAvailable === true } };
        const result = await services.updateOne(query, update);

        if (result.matchedCount === 0) {
            return res.status(404).send({ success: false, message: "Service not found" });
        }

        res.send({ success: true, message: "Service availability updated", modifiedCount: result.modifiedCount });
    } catch (error) {
        console.error("Update Service Availability Error:", error);
        res.status(500).send({ success: false, message: "Failed to update service availability" });
    }
});

app.get('/bookingsrequest',verifyToken, async (req, res) => {
  
    const cursor = bookingsrequest.find({});
    const result = await cursor.toArray();
    res.send(result);
})
app.get('/bookingsrequest/count', async (req, res) => {
    const query = {};
    if (req.query.bookingId) {
        const result = await bookingsrequest.countDocuments(query);
        res.send({ count: result });
    }

})

app.post('/bookingsrequest', async (req, res) => {
    const bookingsrequests = { ...req.body, status: req.body.status || "Pending", requestDate: req.body.requestDate || new Date() };
    console.log(bookingsrequests);
    const result = await bookingsrequest.insertOne(bookingsrequests);
    res.send(result)
});
app.get('/vendor-bookings/:vendorEmail', async (req, res) => {
    try {
        const { vendorEmail } = req.params;

        const requests = await bookingsrequest
            .find({})
            .sort({ requestDate: -1 })
            .toArray();

        const vendorBookings = [];

        for (const booking of requests) {
            if (!ObjectId.isValid(booking.bookingId)) continue;

            const service = await services.findOne({
                _id: new ObjectId(booking.bookingId),
                vendorEmail: vendorEmail
            });

            if (!service) continue;

            vendorBookings.push({
                ...booking,
                customerName: booking.customerName || "Customer",
                serviceName: service.serviceName,
                serviceImage: service.serviceImage,
                vendorName: service.vendorName,
                eventDate: booking.BookingDate,
                eventLocation: booking.BookingLocation,
                status: booking.status || "Pending"
            });
        }

        res.send(vendorBookings);

    } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to fetch bookings" });
    }
});

app.get('/my-bookings/:customerEmail', async (req, res) => {
    try {
        const { customerEmail } = req.params;
        const bookings = await bookingsrequest.find({ email: customerEmail }).sort({ requestDate: -1 }).toArray();
        const enriched = await Promise.all(bookings.map(async (booking) => {
            let serviceName = booking.serviceName || "Unknown Service";
            let serviceImage = booking.serviceImage || "";
            let vendorName = booking.vendorName || "Unknown Vendor";
            let vendorEmail = booking.vendorEmail || "";
            try {
                if (booking.bookingId) {
                    const service = await services.findOne({ _id: new ObjectId(booking.bookingId) });
                    if (service) {
                        serviceName = service.serviceName || serviceName;
                        serviceImage = service.serviceImage || serviceImage;
                        vendorName = service.vendorName || vendorName;
                        vendorEmail = service.vendorEmail || vendorEmail;
                    }
                }
            } catch (err) { /* Invalid ObjectId */ }
            return { ...booking, serviceName, serviceImage, vendorName, vendorEmail, status: booking.status || "Pending", requestDate: booking.requestDate || new Date(), eventDate: booking.BookingDate || booking.eventDate || "", eventLocation: booking.BookingLocation || booking.eventLocation || "" };
        }));
        res.send(enriched);
    } catch (error) {
        console.error("Fetch My Bookings Error:", error);
        res.status(500).send({ success: false, message: "Failed to load bookings" });
    }
});

app.patch('/booking/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        const { customerEmail } = req.body;
        if (!customerEmail) {
            return res.status(400).send({ success: false, message: "Customer email is required" });
        }
        const booking = await bookingsrequest.findOne({ _id: new ObjectId(id) });
        if (!booking) {
            return res.status(404).send({ success: false, message: "Booking not found" });
        }
        if (booking.email !== customerEmail) {
            return res.status(403).send({ success: false, message: "Not authorized to cancel this booking" });
        }
        if (booking.status && booking.status !== "Pending") {
            return res.status(400).send({ success: false, message: `Cannot cancel a ${booking.status} booking` });
        }
        await bookingsrequest.updateOne({ _id: new ObjectId(id) }, { $set: { status: "Cancelled" } });
        res.send({ success: true, message: "Booking cancelled successfully" });
    } catch (error) {
        console.error("Cancel Booking Error:", error);
        res.status(500).send({ success: false, message: "Failed to cancel booking" });
    }
});

app.patch('/add-service/:id/approve', async (req, res) => {
    try {
        const _id = req.params.id;
        const { status } = req.body;
        const query = { _id: new ObjectId(_id) };
        const update = { $set: { status: status } };
        const result = await services.updateOne(query, update);

        if (result.matchedCount === 0) {
            return res.status(404).send({ success: false, message: "Service not found" });
        }

        res.send({ success: true, message: `Service ${status.toLowerCase()} successfully` });
    } catch (error) {
        console.error("Approve/Reject Service Error:", error);
        res.status(500).send({ success: false, message: "Failed to update service status" });
    }
});

// Block/Unblock user
app.patch('/users/:id/block', async (req, res) => {
    try {
        const _id = req.params.id;
        const { isBlocked } = req.body;
        const query = { _id: new ObjectId(_id) };
        const update = { $set: { isBlocked: isBlocked === true, blockedAt: isBlocked ? new Date() : null } };
        const result = await users.updateOne(query, update);

        if (result.matchedCount === 0) {
            return res.status(404).send({ success: false, message: "User not found" });
        }

        res.send({ success: true, message: `User ${isBlocked ? "blocked" : "unblocked"} successfully` });
    } catch (error) {
        console.error("Block User Error:", error);
        res.status(500).send({ success: false, message: "Failed to update user status" });
    }
});

app.post("/upload-profile-image", upload.single("profileImage"), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send({
                message: "No image selected"
            });
        }

        if (!process.env.NEXT_PUBLIC_IMGBB_API_KEY) {
            return res.status(500).send({
                message: "ImgBB API key is missing"
            });
        }

        const formData = new FormData();

        formData.append(
            "image",
            new Blob([req.file.buffer], {
                type: req.file.mimetype
            }),
            req.file.originalname
        );

        const response = await fetch(
            `https://api.imgbb.com/1/upload?key=${process.env.NEXT_PUBLIC_IMGBB_API_KEY}`,
            {
                method: "POST",
                body: formData
            }
        );

        const result = await response.json();

        if (!response.ok || !result.success) {
            console.log("ImgBB Error:", result.error);

            return res.status(500).send({
                message: result.error?.message || "ImgBB upload failed"
            });
        }

        res.send({
            success: true,
            imageUrl: result.data.url
        });

    } catch (error) {
        console.error("Profile image upload error:", error);

        res.status(500).send({
            message: "Server image upload error"
        });
    }
});
//payment related api 
app.post('/payments/checkout-verify', async (req, res) => {
    try {
        const { session_id } = req.body;

        if (!session_id) {
            return res.status(400).send({ success: false, message: "session_id is required" });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.status === 'complete' && session.payment_status === 'paid') {
            const sessionQuery = { sessionId: session_id };
            const existingPayment = await payments.findOne(sessionQuery);

            if (existingPayment) {
                return res.send({ success: false, message: "Payment already verified"});
            }
            const payment = {
                sessionId: session_id,
                status: session.status,
                payment_status: session.payment_status,
                customer_email: session.customer_email,
                userId: session.metadata?.userId,
                payment_date: new Date(),
                payment_intent: session.payment_intent,
            }
            const result = await payments.insertOne(payment);

            //update the user table
            if (session.metadata?.userId && ObjectId.isValid(session.metadata.userId)) {
                const query = { _id: new ObjectId(session.metadata.userId) };

                const updatedDoc = {
                    $set: {
                        premium: true,
                    }
                };
                const updateResult = await users.updateOne(
                    query,
                    updatedDoc
                );
                return res.send({ success: true, result, updateResult, message: "Payment verified and user updated successfully" });
            }

            return res.send({ success: true, result, message: "Payment recorded successfully" });
        }

        res.send({ success: false, message: "Payment verification failed" });
    } catch (error) {
        console.error("Checkout Verify Error:", error);
        res.status(500).send({ success: false, message: "Payment verification failed", error: error.message });
    }
})

app.listen(port, () => {
    console.log(`server is running on port ${port}`);
});