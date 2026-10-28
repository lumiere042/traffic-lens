import os
import stripe
from fastapi import FastAPI, Depends, Header, HTTPException

stripe.api_key = os.environ["STRIPE_API_KEY"]
app = FastAPI()


def verify_internal_token(x_internal_token: str = Header(...)):
    if x_internal_token != os.environ["INTERNAL_TOKEN"]:
        raise HTTPException(status_code=403)


@app.post("/charges", dependencies=[Depends(verify_internal_token)])
def create_charge(body: dict):
    intent = stripe.PaymentIntent.create(amount=body["amount"], currency="usd", metadata={"user": body["userId"]})
    return {"id": intent.id, "status": intent.status}


@app.get("/charges/{charge_id}", dependencies=[Depends(verify_internal_token)])
def get_charge(charge_id: str):
    intent = stripe.PaymentIntent.retrieve(charge_id)
    return {"id": intent.id, "status": intent.status}
