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

app.get('/', (req, res) => {
    res.send('wedplan webpage');
});

app.get('/users', async(req, res)=> {
    const cursor = users.find({});
    const result = await cursor.toArray();
    res.send(result);
})
app.get('/add-service', async(req, res)=> {
    const cursor = services.find();
    const result = await cursor.toArray();
    res.send(result);
})

app.post('/add-service', upload.single('serviceImage'), async (req, res) => {
    try {
        const {
            serviceName,
            category,
            description,
            price,
            location
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
app.delete('/add-service/:id', async (req, res)=> {
    const _id = req.params.id;
    const query = {_id: new ObjectId(_id)};
    const result = await services.deleteOne(query);
    res.send(result)
})

app.listen(port, () => {
    console.log(`server is running on port ${port}`);
});