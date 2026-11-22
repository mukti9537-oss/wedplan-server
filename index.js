import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'
import multer from 'multer';

const app = express();
const port = process.env.PORT || 8000;

//middleware
app.use(express.json());
app.use(cors());
const upload = multer({
    storage: multer.memoryStorage()
});

const client = new MongoClient(`mongodb://${process.env.DB_USER}:${process.env.DB_PASSWORD}@ac-sed4pgj-shard-00-00.la1zoji.mongodb.net:27017,ac-sed4pgj-shard-00-01.la1zoji.mongodb.net:27017,ac-sed4pgj-shard-00-02.la1zoji.mongodb.net:27017/?ssl=true&replicaSet=atlas-sjdwaf-shard-0&authSource=admin`);

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

app.get('/', (req, res) => {
    res.send('wedplan webpage');
});

app.get('/users', async (req, res) => {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})

app.get('/add-service', async (req, res) => {

    const { search, category, location } = req.query;

    const query = {};

    // Search by service name
    if (search) {
        query.serviceName = {
            $regex: search,
            $options: 'i'
        };
    }

    // Filter by category
    if (category) {
        query.category = {
            $regex: category,
            $options: 'i'
        };
    }

    // Filter by location
    if (location) {
        query.location = {
            $regex: location,
            $options: 'i'
        };
    }

    const result = await services.find(query).toArray();

    res.send(result);
});


app.post('/add-service', upload.single('serviceImage'), async (req, res) => {
    try {
        const {
            serviceName,
            category,
            description,
            price,
            location,
            vendorName,
            vendorEmail
        } = req.body;

        // Check image
        if (!req.file) {
            return res.status(400).send({
                success: false,
                message: "Service image is required"
            });
        }

        // Upload image to ImgBB
        const formData = new FormData();

        const imageBlob = new Blob([req.file.buffer], {
            type: req.file.mimetype
        });

        formData.append('image', imageBlob, req.file.originalname);

        const imgbbResponse = await fetch(
            `https://api.imgbb.com/1/upload?key=${process.env.NEXT_PUBLIC_IMGBB_API_KEY}`,
            {
                method: 'POST',
                body: formData
            }
        );

        const imageResult = await imgbbResponse.json();

        if (!imageResult.success) {
            throw new Error("ImgBB image upload failed");
        }

        const imageUrl = imageResult.data.url;

        // Service data
        const serviceData = {
            serviceName,
            category,
            description,
            price: Number(price),
            location,
            serviceImage: imageUrl,
            vendorName,
            vendorEmail,
            createdAt: new Date()
        };

        // Save to MongoDB
        const result = await services.insertOne(serviceData);

        res.status(201).send({
            success: true,
            message: "Service added successfully",
            insertedId: result.insertedId
        });

    } catch (error) {
        console.error("Add Service Error:", error);

        res.status(500).send({
            success: false,
            message: "Failed to add service",
            error: error.message
        });
    }
});

app.delete('/add-service/:id', async (req, res) => {
    const _id = req.params.id;
    const query = { _id: new ObjectId(_id) };
    const result = await services.deleteOne(query);
    res.send(result)
})
//booking related api

app.get('/bookingsrequest', async (req, res) => {
    const cursor = bookingsrequest.find({});
    const result = await cursor.toArray();
    res.send(result);
})

app.post('/bookingsrequest', async (req, res) => {
    const bookingsrequests = {
        ...req.body,
        status: req.body.status || "Pending",
        requestDate: req.body.requestDate || new Date(),
    };
    console.log(bookingsrequests);

    const result = await bookingsrequest.insertOne(bookingsrequests);
    res.send(result)
});

// Get all bookings for a specific customer (enriched with service details)
app.get('/my-bookings/:customerEmail', async (req, res) => {
    try {
        const { customerEmail } = req.params;

        const bookings = await bookingsrequest
            .find({ email: customerEmail })
            .sort({ requestDate: -1 })
            .toArray();

        // Enrich each booking with service details from the services collection
        const enriched = await Promise.all(bookings.map(async (booking) => {
            let serviceName = booking.serviceName || "Unknown Service";
            let serviceImage = booking.serviceImage || "";
            let vendorName = booking.vendorName || "Unknown Vendor";
            let vendorEmail = booking.vendorEmail || "";

            try {
                if (booking.bookingId) {
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
                // Invalid ObjectId — keep existing values
            }

            return {
                ...booking,
                serviceName,
                serviceImage,
                vendorName,
                vendorEmail,
                status: booking.status || "Pending",
                requestDate: booking.requestDate || new Date(),
                eventDate: booking.BookingDate || booking.eventDate || "",
                eventLocation: booking.BookingLocation || booking.eventLocation || "",
            };
        }));

        res.send(enriched);
    } catch (error) {
        console.error("Fetch My Bookings Error:", error);
        res.status(500).send({
            success: false,
            message: "Failed to load bookings",
        });
    }
});

// Cancel a booking (customer can only cancel their own pending bookings)
app.patch('/booking/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        const { customerEmail } = req.body;

        if (!customerEmail) {
            return res.status(400).send({
                success: false,
                message: "Customer email is required",
            });
        }

        const booking = await bookingsrequest.findOne({
            _id: new ObjectId(id),
        });

        if (!booking) {
            return res.status(404).send({
                success: false,
                message: "Booking not found",
            });
        }

        // Rule: Customers cannot cancel another customer's bookings
        if (booking.email !== customerEmail) {
            return res.status(403).send({
                success: false,
                message: "Not authorized to cancel this booking",
            });
        }

        // Rule: Cannot cancel an already accepted, rejected, or cancelled booking
        if (booking.status && booking.status !== "Pending") {
            return res.status(400).send({
                success: false,
                message: `Cannot cancel a ${booking.status} booking`,
            });
        }

        await bookingsrequest.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "Cancelled" } }
        );

        res.send({
            success: true,
            message: "Booking cancelled successfully",
        });
    } catch (error) {
        console.error("Cancel Booking Error:", error);
        res.status(500).send({
            success: false,
            message: "Failed to cancel booking",
        });
    }
});


app.listen(port, () => {
    console.log(`server is running on port ${port}`);
});